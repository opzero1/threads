import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Link, threads, workerIdentity, workflowExecutionAuthorized, authorizeWorkflowExecution, watchWorkflowExecution, serialized } from "../src/threads";
import type { Schema } from "effect";
import plugin from "../index";
import type { SessionContext } from "@opencode/plugin/promise/session";

async function ownerContextHook(ctx: Pick<Plugin.Context, "session" | "storage" | "agent">) {
  let hook: ((event: SessionContext) => unknown) | undefined;
  const stop = new Error("threads registration captured");
  // Stop after the real Threads hooks/tools register, before unrelated workflow setup.
  await expect(Promise.resolve(plugin.setup({ ...ctx, options: {},
    session: { ...ctx.session, async hook(name: string, callback: typeof hook) { if (name === "context") hook = callback; } },
    rpc: { async register() {} }, tool: { async transform() { throw stop; } },
  } as unknown as Plugin.Context))).rejects.toBe(stop);
  if (!hook) throw new Error("Owner context hook not registered");
  const registered = hook;
  return async (sessionID: Session.ID) => {
    const event = { sessionID, model: { providerID: "fixture", modelID: "fixture" }, system: [], messages: [], options: {}, tools: {}, agent: "fixture" } as unknown as SessionContext;
    await registered(event);
    return event;
  };
}

function harness() {
  const ownerID = Session.ID.create();
  const workerID = workerIdentity(ownerID, "original");
  const link = Link.parse({ workerID, coordinatorID: ownerID, key: "original", fingerprint: "original",
    initialMessageID: SessionMessage.ID.create(), reportMessageID: SessionMessage.ID.create() });
  const values = new Map<string, Schema.Json>([
    [`workers/${ownerID}/${workerID}`, link],
    [`reports/${workerID}/${link.reportMessageID}`, { verdict: "PASS", summary: "Original", evidence: [] }],
  ]);
  let failState: string | undefined;
  let stickyFailure = false;
  const storage: Plugin.Context["storage"] = {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) {
      if (typeof value === "object" && value !== null && "state" in value && value.state === failState) {
        if (!stickyFailure) failState = undefined;
        throw new Error("interrupted write");
      }
      values.set(key, structuredClone(value));
    },
    async remove(key) { values.delete(key); },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort();
      const page = keys.slice(0, limit);
      return { entries: page.map(key => ({ key, value: values.get(key)! })), next: keys.length > page.length ? page.at(-1) : undefined };
    },
  };
  const messages: Awaited<ReturnType<Plugin.Context["session"]["context"]>> = [];
  const ownerMessages: typeof messages = [];
  const admitted = new Map<string, Awaited<ReturnType<Plugin.Context["session"]["synthetic"]>>>();
  const notices: Parameters<Plugin.Context["session"]["synthetic"]>[0][] = [];
  let wakes = 0;
  let rejectAdmission = false;
  let rejectWake = false;
  let beforeWake = () => {};
  let finish = () => {};
  let waiting = Promise.resolve();
  const session = {
    async get({ sessionID }: { sessionID: string }) {
      return { id: sessionID, location: { directory: process.cwd() }, metadata: sessionID === workerID ? {
        opThreads: link, opWorkflow: { ownerID, runID: "original", stepKey: "step", callerAgent: "caller" },
      } : {} };
    },
    async context({ sessionID }: { sessionID: string }) { return sessionID === workerID ? messages : ownerMessages; },
    async wait() { await waiting; },
    async synthetic(input: Parameters<Plugin.Context["session"]["synthetic"]>[0]) {
      if (rejectAdmission && input.sessionID === workerID) throw new Error("admission rejected");
      if (input.sessionID === workerID && input.resume !== false) beforeWake();
      if (rejectWake && input.sessionID === workerID && input.resume !== false) throw new Error("wake rejected");
      const id = input.id ?? SessionMessage.ID.create();
      const prior = admitted.get(id);
      if (prior && prior.payload.text !== input.text) throw { _tag: "Session.SyntheticConflictError", sessionID: input.sessionID, inputID: id };
      const result = prior ?? { id, sessionID: input.sessionID, type: "synthetic" as const,
        payload: { text: input.text, metadata: input.metadata }, delivery: input.delivery ?? "steer", time: { created: Date.now() } };
      admitted.set(id, result);
      if (input.sessionID === ownerID && input.resume !== false && !ownerMessages.some(message => message.id === id)) {
        notices.push(input);
        ownerMessages.push({ id, type: "synthetic", text: input.text, time: { created: Date.now() } });
      }
      if (input.sessionID === workerID && input.resume !== false) {
        wakes++;
        waiting = new Promise<void>(resolve => { finish = resolve; });
        if (!messages.some(message => message.id === id)) messages.push({ id, type: "synthetic", text: input.text, time: { created: Date.now() } });
      }
      return result;
    },
  };
  // Only the API methods exercised by send/list are implemented at this test boundary.
  const ctx = { session, storage, agent: {} } as unknown as Pick<Plugin.Context, "session" | "storage" | "agent">;
  return { ownerID, workerID, values, messages, admitted, notices, ctx,
    api: threads(ctx), reopen: () => threads(ctx), wakes: () => wakes,
    reject: () => { rejectAdmission = true; },
    allow: () => { rejectAdmission = false; },
    rejectWake: () => { rejectWake = true; },
    allowWake: () => { rejectWake = false; },
    beforeWake: (callback: () => void) => { beforeWake = callback; },
    failNextState: (state: string, sticky = false) => { failState = state; stickyFailure = sticky; },
    allowWrites: () => { failState = undefined; },
    complete(outcome: "succeeded" | "failed" | "interrupted" = "succeeded") {
      messages.push({ id: SessionMessage.ID.create(), type: "idle", outcome, time: { created: Date.now() } }); finish();
    },
  };
}

test("follow-up completion wakes coordinator separately without replacing original report", async () => {
  const h = harness();
  const before = structuredClone([...h.values.entries()]);
  const output = await h.api.send(h.ownerID, { workerID: h.workerID, key: "fix", text: "Inspect the follow-up" });
  expect(Object.keys(output)).toEqual(["workerID", "messageID"]);
  expect(h.notices).toHaveLength(0);
  h.complete();
  await h.api.list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.resume).toBe(true);
  expect(h.notices[0]?.text).toContain(output.messageID);
  expect(h.notices[0]?.text).toContain("inspect");
  expect(h.notices[0]?.text).not.toContain('"verdict":"PASS"');
  for (const [key, value] of before.filter(([key]) => key.startsWith("reports/"))) expect(h.values.get(key)).toEqual(value);
});

test("duplicate and conflicting keys do not wake or create a fresh grant", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "retry", text: "One request" };
  const original = await h.api.send(h.ownerID, input);
  h.complete();
  await h.api.list(h.ownerID);
  watchWorkflowExecution(h.workerID, async () => {});
  await Promise.resolve();
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  expect(await h.api.send(h.ownerID, input)).toEqual(original);
  await expect(h.api.send(h.ownerID, { ...input, text: "Different" })).rejects.toThrow("different text");
  expect(h.wakes()).toBe(1);
  expect(h.notices).toHaveLength(1);
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("rejected send preserves an existing authorization and its watcher", async () => {
  const h = harness();
  authorizeWorkflowExecution(h.workerID);
  let revoke = () => {};
  watchWorkflowExecution(h.workerID, () => new Promise<void>(resolve => { revoke = resolve; }));
  h.reject();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "rejected", text: "No" })).rejects.toThrow();
  expect(workflowExecutionAuthorized(h.workerID)).toBe(true);
  revoke();
  await Promise.resolve();
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("stale idle cannot complete a newly accepted follow-up", async () => {
  const h = harness();
  h.complete();
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "new", text: "New work" });
  await h.api.list(h.ownerID);
  expect(h.notices).toHaveLength(0);
  h.complete("failed");
  await h.api.list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain("failed");
});

test("reopening reconciles completion and retries without reexecution or renotification", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "restart", text: "Follow-up" };
  const original = await h.api.send(h.ownerID, input);
  h.complete("interrupted");
  const reopened = h.reopen();
  await reopened.list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain("interrupted");
  expect(await reopened.send(h.ownerID, input)).toEqual(original);
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(1);
  expect(h.notices).toHaveLength(1);
});

test("journal before admission recovers interrupted delivery on an identical retry", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "interrupted-admission", text: "Recover me" };
  h.reject();
  await expect(h.api.send(h.ownerID, input)).rejects.toThrow();
  expect([...h.values.keys()].some(key => key.startsWith("followups/"))).toBe(true);
  expect(h.wakes()).toBe(0);
  h.allow();
  await h.reopen().send(h.ownerID, input);
  expect(h.wakes()).toBe(1);
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
});

test("reopening recovers interrupted accepted-state write before wake", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "accepted-write", text: "Recovery" };
  h.failNextState("accepted");
  await expect(h.api.send(h.ownerID, input)).rejects.toThrow();
  expect(h.admitted.size).toBe(1);
  expect(h.wakes()).toBe(0);
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(1);
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
});

test("UI snapshots and restore remain available when a pending follow-up cannot wake", async () => {
  const h = harness();
  h.rejectWake();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "unavailable", text: "Pending work" })).rejects.toThrow("wake rejected");
  const pending = structuredClone([...h.values.entries()].filter(([key]) => key.startsWith("followup")));
  const snapshot = await h.reopen().list(h.ownerID, "snapshot");
  expect(snapshot.map(worker => worker.workerID)).toEqual([h.workerID]);
  expect(await h.reopen().restore(h.ownerID)).toHaveLength(1);
  expect([...h.values.entries()].filter(([key]) => key.startsWith("followup"))).toEqual(pending);
  expect(h.wakes()).toBe(0);
  expect(await h.reopen().list(h.ownerID)).toHaveLength(1);
  h.allowWake();
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(1);
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
});

test("a crash after coordinator delivery retries the frozen completion without renotifying", async () => {
  const h = harness();
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "notify-crash", text: "Notify once" });
  h.failNextState("notified", true);
  h.complete();
  expect(await h.api.list(h.ownerID)).toHaveLength(1);
  expect(h.notices).toHaveLength(1);
  h.allowWrites();
  h.messages.splice(0);
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.wakes()).toBe(1);
});

test("prompt-hook race preserves the admitted execution's existing grant watcher", async () => {
  const h = harness();
  authorizeWorkflowExecution(h.workerID);
  let finish = () => {};
  watchWorkflowExecution(h.workerID, () => new Promise<void>(resolve => { finish = resolve; }));
  await h.api.prepareWorkflowPrompt(h.workerID, SessionMessage.ID.create());
  finish();
  await Promise.resolve();
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("native key rejection leaves no grant or poisoned reconciliation entry", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "native-conflict", text: "Canonical" };
  const output = await h.api.send(h.ownerID, input);
  h.complete();
  await h.api.list(h.ownerID);
  for (const key of [...h.values.keys()]) if (key.startsWith("followups/")) h.values.delete(key);
  await expect(h.api.send(h.ownerID, { ...input, text: "Conflict" })).rejects.toMatchObject({ _tag: "Session.SyntheticConflictError" });
  expect(h.admitted.get(output.messageID)?.payload.text).toBe("Canonical");
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  expect([...h.values.keys()].filter(key => key.startsWith("followup-pending/"))).toHaveLength(0);
  await h.api.list(h.ownerID);
  expect(h.wakes()).toBe(1);
});

test("compaction hiding the admitted message is unresolved, never a stale-idle completion or fresh wake", async () => {
  const h = harness();
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "compacted", text: "Older input" });
  h.complete();
  h.messages.splice(0);
  h.messages.push({ id: SessionMessage.ID.create(), type: "compaction", status: "completed", reason: "auto",
    summary: "Truncated history", time: { created: Date.now() + 1000 } });
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(1);
  expect(h.notices).toHaveLength(0);
  expect([...h.values.keys()].some(key => key.startsWith("followup-pending/"))).toBe(true);
});

test("native wait completion notifies without a coordinator list call", async () => {
  const h = harness();
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "watched", text: "Watch this admission" });
  h.complete();
  await h.ctx.session.wait({ sessionID: h.workerID });
  await serialized(`followup/${h.workerID}`, async () => {});
  expect(h.notices).toHaveLength(1);
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("wake rejection rolls back only its new grant while durable queue acceptance recovers", async () => {
  const h = harness();
  h.rejectWake();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "wake-retry", text: "Accepted but not woken" })).rejects.toThrow("wake rejected");
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  expect(h.admitted.size).toBe(1);
  expect(h.wakes()).toBe(0);
  h.allowWake();
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(1);
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
});

test("rejected native admission creates no workflow execution grant", async () => {
  const h = harness();
  h.reject();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "bad", text: "Rejected" })).rejects.toThrow();
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("identical send retry wakes an accepted follow-up after rejection", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "retry-accepted", text: "Recover accepted wake" };
  h.rejectWake();
  await expect(h.api.send(h.ownerID, input)).rejects.toThrow("wake rejected");
  const messageID = [...h.admitted.values()][0].id;
  h.allowWake();
  const retried = await h.reopen().send(h.ownerID, input);
  expect(retried.workerID).toBe(h.workerID);
  expect(String(retried.messageID)).toBe(messageID);
  expect(h.admitted.size).toBe(1);
  expect(h.wakes()).toBe(1);
  expect(workflowExecutionAuthorized(h.workerID)).toBe(true);
  h.complete();
  await h.ctx.session.wait({ sessionID: h.workerID });
  await serialized(`followup/${h.workerID}`, async () => {});
  expect(h.notices).toHaveLength(1);
});

test("identical send retry settles a completed follow-up after notification write failure", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "retry-completed", text: "Finish delivery bookkeeping" };
  const sent = await h.api.send(h.ownerID, input);
  h.failNextState("notified", true);
  h.complete();
  await h.ctx.session.wait({ sessionID: h.workerID });
  await serialized(`followup/${h.workerID}`, async () => {});
  expect([...h.values.keys()].filter(key => key.startsWith("followup-pending/"))).toHaveLength(1);
  h.allowWrites();
  expect(await h.reopen().send(h.ownerID, input)).toEqual(sent);
  expect([...h.values.keys()].filter(key => key.startsWith("followup-pending/"))).toHaveLength(0);
  expect(h.wakes()).toBe(1);
  expect(h.notices).toHaveLength(1);
});

test("an earlier execution ending during follow-up wake cannot revoke the new admission", async () => {
  const h = harness();
  authorizeWorkflowExecution(h.workerID);
  let endEarlier = () => {};
  watchWorkflowExecution(h.workerID, () => new Promise<void>(resolve => { endEarlier = resolve; }));
  h.beforeWake(() => endEarlier());
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "overlapping-idle", text: "New admitted work" });
  expect(h.wakes()).toBe(1);
  expect(workflowExecutionAuthorized(h.workerID)).toBe(true);
  h.complete();
  await h.ctx.session.wait({ sessionID: h.workerID });
  await serialized(`followup/${h.workerID}`, async () => {});
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

for (const endsEarlier of [false, true]) {
  test(`rejected wake preserves only a still-live earlier grant (ended: ${endsEarlier})`, async () => {
    const h = harness();
    authorizeWorkflowExecution(h.workerID);
    let endEarlier = () => {};
    watchWorkflowExecution(h.workerID, () => new Promise<void>(resolve => { endEarlier = resolve; }));
    if (endsEarlier) h.beforeWake(() => endEarlier());
    h.rejectWake();
    await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "rejected-overlap", text: "Rejected wake" })).rejects.toThrow("wake rejected");
    expect(workflowExecutionAuthorized(h.workerID)).toBe(!endsEarlier);
    endEarlier();
    await Promise.resolve();
    expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  });
}

test("legacy cached grants without revocation tracking cannot authorize a new plugin instance", () => {
  const workerID = Session.ID.create();
  const legacy = globalThis as typeof globalThis & { __opWorkflowExecutionGrantsV2?: Map<string, { watching: boolean }> };
  const grants = legacy.__opWorkflowExecutionGrantsV2 ??= new Map();
  grants.set(workerID, { watching: true });
  try {
    expect(workflowExecutionAuthorized(workerID)).toBe(false);
  } finally {
    grants.delete(workerID);
  }
});

test("registered owner context isolates poison records, advances pages and recovers after restart", async () => {
  const h = harness();
  const reports = [...h.values.entries()].filter(([key]) => key.startsWith("reports/"));
  const poison = { workerID: h.workerID, coordinatorID: h.ownerID,
    messageID: SessionMessage.ID.make(`msg_${"0".repeat(32)}`), notificationID: SessionMessage.ID.create(),
    text: "Retry this rejected wake", state: "accepted" };
  h.values.set(`followups/${h.workerID}/${poison.messageID}`, poison);
  h.values.set(`followup-pending/${h.ownerID}/${poison.messageID}`, poison);
  for (let i = 1; i <= 100; i++) {
    const entry = { ...poison, messageID: SessionMessage.ID.make(`msg_${String(i).padStart(32, "0")}`),
      notificationID: SessionMessage.ID.create(), state: "completed",
      completion: { outcome: "succeeded", idleMessageID: SessionMessage.ID.create() } };
    h.values.set(`followups/${h.workerID}/${entry.messageID}`, entry);
    h.values.set(`followup-pending/${h.ownerID}/${entry.messageID}`, entry);
  }
  h.rejectWake();
  const context = await ownerContextHook(h.ctx);
  const first = await context(h.ownerID);
  expect(h.notices).toHaveLength(99);
  expect(JSON.stringify(first.system)).toContain(poison.messageID);
  expect(JSON.stringify(first.system)).toContain("wake rejected");
  expect(h.values.has(`followup-cursor/${h.ownerID}`)).toBe(true);
  await context(h.ownerID);
  expect(h.notices).toHaveLength(100);
  expect(h.values.has(`followup-cursor/${h.ownerID}`)).toBe(false);
  expect(h.values.get(`followups/${h.workerID}/${poison.messageID}`)).toMatchObject({ state: "accepted" });
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  expect(h.wakes()).toBe(0);
  h.allowWake();
  const restarted = await ownerContextHook(h.ctx);
  await restarted(h.ownerID);
  expect(h.wakes()).toBe(1);
  h.complete();
  await restarted(h.ownerID);
  await restarted(h.ownerID);
  expect(h.notices).toHaveLength(101);
  expect(h.wakes()).toBe(1);
  expect([...h.values.keys()].filter(key => key.startsWith("followup-pending/"))).toHaveLength(0);
  for (const [key, value] of reports) expect(h.values.get(key)).toEqual(value);
});

test("registered owner context survives storage-wide failure with bounded diagnostics", async () => {
  const h = harness();
  const context = await ownerContextHook({ ...h.ctx, storage: { ...h.ctx.storage,
    scan: async () => { throw new Error(`storage unavailable ${"x".repeat(2000)}`); },
  } });
  const event = await context(h.ownerID);
  expect(JSON.stringify(event.system)).toContain("storage unavailable");
  expect(JSON.stringify(event.system).length).toBeLessThan(1000);
  expect(h.notices).toHaveLength(0);
});

test("background conflict retains retry records while explicit conflict still rejects without grants", async () => {
  const h = harness();
  const input = { workerID: h.workerID, key: "recovery-conflict", text: "Journal text" };
  h.reject();
  await expect(h.api.send(h.ownerID, input)).rejects.toThrow("admission rejected");
  h.allow();
  const id = SessionMessage.ID.make([...h.values.keys()].find(key => key.startsWith("followups/"))!.split("/").at(-1)!);
  await h.ctx.session.synthetic({ sessionID: h.workerID, id, text: "Native canonical text", resume: false });
  const pending = [...h.values.entries()].filter(([key]) => key.startsWith("followup"));
  const context = await ownerContextHook(h.ctx);
  expect(JSON.stringify((await context(h.ownerID)).system)).toContain(id);
  expect([...h.values.entries()].filter(([key]) => key.startsWith("followup"))).toEqual(pending);
  expect(h.wakes()).toBe(0);
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
  await expect(h.reopen().send(h.ownerID, input)).rejects.toMatchObject({ _tag: "Session.SyntheticConflictError" });
  expect(workflowExecutionAuthorized(h.workerID)).toBe(false);
});

test("malformed and missing-worker records are retained with capped context diagnostics", async () => {
  const h = harness();
  const missingID = Session.ID.create();
  const missing = { workerID: missingID, coordinatorID: h.ownerID, messageID: SessionMessage.ID.create(),
    notificationID: SessionMessage.ID.create(), text: "Missing worker", state: "prepared" };
  h.values.set(`followup-pending/${h.ownerID}/${missing.messageID}`, missing);
  h.values.set(`followups/${missingID}/${missing.messageID}`, missing);
  for (let i = 0; i < 9; i++) h.values.set(`followup-pending/${h.ownerID}/malformed-${i}`, { bad: true });
  const original = structuredClone([...h.values.entries()]);
  const context = await ownerContextHook(h.ctx);
  const event = await context(h.ownerID);
  expect(JSON.stringify(event.system)).toContain("additional recovery failures");
  expect(JSON.stringify(event.system).length).toBeLessThan(3000);
  await context(h.ownerID);
  expect([...h.values.entries()]).toEqual(original);
  expect(h.notices).toHaveLength(0);
  expect(h.wakes()).toBe(0);
});

test("registered owner context also isolates cursor-read and cursor-write storage failures", async () => {
  for (const operation of ["get", "remove"] as const) {
    const h = harness();
    const context = await ownerContextHook({ ...h.ctx, storage: { ...h.ctx.storage,
      [operation]: async () => { throw new Error(`cursor ${operation} unavailable`); },
    } });
    expect(JSON.stringify((await context(h.ownerID)).system)).toContain(`cursor ${operation} unavailable`);
  }
});
