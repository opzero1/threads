import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Link, threads, workerIdentity, workflowExecutionAuthorized, authorizeWorkflowExecution, watchWorkflowExecution, serialized } from "../src/threads";
import type { Schema } from "effect";
import plugin from "../index";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { type Inbox, inboxUnavailable } from "../src/inbox";

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
  let beforeInterrupt = () => {};
  let finish = () => {};
  let waiting = Promise.resolve();
  // Native inbox model: admitted worker input waits here until a wake reaches an idle worker.
  // A wake during a busy turn only rings the doorbell, and an interrupt clears that doorbell.
  const queue: string[] = [];
  // Steered input skips the queue: a busy turn takes it at its next step.
  const steers: string[] = [];
  let busy = false;
  let doorbell = false;
  let interrupts = 0;
  const promote = () => {
    for (const id of [...steers.splice(0), ...queue.splice(0)]) {
      if (!messages.some(message => message.id === id)) messages.push({ id, type: "synthetic", text: admitted.get(id)!.payload.text, time: { created: Date.now() } });
    }
  };
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
      if (input.sessionID === workerID && !messages.some(message => message.id === id) && !queue.includes(id) && !steers.includes(id)) queue.push(id);
      if (input.sessionID === ownerID && input.resume !== false && !ownerMessages.some(message => message.id === id)) {
        notices.push(input);
        ownerMessages.push({ id, type: "synthetic", text: input.text, time: { created: Date.now() } });
      }
      if (input.sessionID === workerID && input.resume !== false) {
        wakes++;
        if (busy) doorbell = true;
        else {
          waiting = new Promise<void>(resolve => { finish = resolve; });
          promote();
        }
      }
      return result;
    },
    async interrupt({ sessionID }: { sessionID: string; resume?: boolean }) {
      if (sessionID !== workerID) return { interrupted: false };
      interrupts++;
      beforeInterrupt();
      if (!busy) return { interrupted: false };
      busy = false;
      doorbell = false;
      messages.push({ id: SessionMessage.ID.create(), type: "idle", outcome: "interrupted", time: { created: Date.now() } });
      finish();
      return { interrupted: true };
    },
  };
  const inboxCalls: string[] = [];
  let inboxDown = false;
  const failInbox = new Set<string>();
  const check = (call: string) => {
    inboxCalls.push(call);
    if (inboxDown) throw new Error(inboxUnavailable);
    if (failInbox.has(call.split(" ")[0]!)) throw new Error(`${call.split(" ")[0]} rejected`);
  };
  const move = (from: string[], to: string[], id: string) => {
    const index = from.indexOf(id);
    if (index === -1) return "unavailable" as const;
    from.splice(index, 1);
    to.push(id);
    return "moved" as const;
  };
  const inbox: Inbox = {
    async pending() { check("pending"); return [...steers, ...queue]; },
    async steer(_sessionID, id) {
      check(`steer ${id}`);
      const result = move(queue, steers, id);
      if (result === "moved" && !busy) {
        waiting = new Promise<void>(resolve => { finish = resolve; });
        promote();
      }
      return result;
    },
    async queue(_sessionID, id) { check(`queue ${id}`); return move(steers, queue, id); },
    async cancel(_sessionID, id) {
      check(`cancel ${id}`);
      for (const list of [queue, steers]) if (list.includes(id)) list.splice(list.indexOf(id), 1);
    },
  };
  // Only the API methods exercised by send/list are implemented at this test boundary.
  const ctx = { session, storage, agent: {} } as unknown as Pick<Plugin.Context, "session" | "storage" | "agent">;
  return { ownerID, workerID, values, messages, admitted, notices, ctx, inbox,
    api: threads(ctx, 4, inbox), reopen: () => threads(ctx, 4, inbox), wakes: () => wakes,
    inboxCalls: () => [...inboxCalls], steers: () => [...steers],
    inboxDown: (down = true) => { inboxDown = down; },
    failInbox: (call: string) => { failInbox.add(call); },
    // A busy turn reaches its next step boundary and takes steered input.
    step() {
      for (const id of steers.splice(0)) messages.push({ id, type: "synthetic", text: admitted.get(id)!.payload.text, time: { created: Date.now() } });
    },
    reject: () => { rejectAdmission = true; },
    allow: () => { rejectAdmission = false; },
    rejectWake: () => { rejectWake = true; },
    allowWake: () => { rejectWake = false; },
    beforeWake: (callback: () => void) => { beforeWake = callback; },
    beforeInterrupt: (callback: () => void) => { beforeInterrupt = callback; },
    interrupts: () => interrupts,
    queued: () => [...queue],
    doorbell: () => doorbell,
    // Starts a native turn that later admissions wait behind.
    busy() { busy = true; waiting = new Promise<void>(resolve => { finish = resolve; }); },
    // The busy turn reaches its idle boundary and promotes the next queued input.
    promoteQueued() { busy = false; doorbell = false; promote(); },
    failNextState: (state: string, sticky = false) => { failState = state; stickyFailure = sticky; },
    allowWrites: () => { failState = undefined; },
    complete(outcome: "succeeded" | "failed" | "interrupted" = "succeeded") {
      busy = false;
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

const pendingKeys = (h: ReturnType<typeof harness>) => [...h.values.keys()].filter(key => key.startsWith("followup-pending/"));
const settleWatchers = async (h: ReturnType<typeof harness>) => {
  await h.ctx.session.wait({ sessionID: h.workerID });
  await serialized(`followup/${h.workerID}`, async () => {});
};

test("interrupt holds a follow-up queued behind the running turn and no later pass wakes it", async () => {
  const h = harness();
  h.busy();
  const queued = await h.api.send(h.ownerID, { workerID: h.workerID, key: "queued", text: "Queued behind the run" });
  expect(h.queued()).toEqual([queued.messageID]);
  expect(h.doorbell()).toBe(true);
  const wakes = h.wakes();
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(stopped.heldFollowups).toEqual([queued.messageID]);
  expect(h.interrupts()).toBe(1);
  expect(h.doorbell()).toBe(false);
  const context = await ownerContextHook(h.ctx);
  await context(h.ownerID);
  await h.api.list(h.ownerID);
  await h.reopen().list(h.ownerID);
  await context(h.ownerID);
  expect(h.wakes()).toBe(wakes);
  expect(h.messages.some(message => message.id === queued.messageID)).toBe(false);
  expect(h.queued()).toEqual([queued.messageID]);
  expect(h.notices).toHaveLength(0);
  expect(pendingKeys(h)).toHaveLength(1);
});

test("a native interrupt is not undone by recovery of a woken follow-up", async () => {
  const h = harness();
  h.busy();
  const queued = await h.api.send(h.ownerID, { workerID: h.workerID, key: "native", text: "Queued before a native stop" });
  const wakes = h.wakes();
  await h.ctx.session.interrupt({ sessionID: h.workerID, resume: false });
  await (await ownerContextHook(h.ctx))(h.ownerID);
  await h.reopen().list(h.ownerID);
  expect(h.wakes()).toBe(wakes);
  expect(h.queued()).toEqual([queued.messageID]);
  expect(h.notices).toHaveLength(0);
});

test("a later explicit send resumes held follow-ups and reports them", async () => {
  const h = harness();
  h.busy();
  const held = await h.api.send(h.ownerID, { workerID: h.workerID, key: "held", text: "Held work" });
  expect((await h.api.interrupt(h.ownerID, { workerID: h.workerID })).heldFollowups).toEqual([held.messageID]);
  const next = await h.reopen().send(h.ownerID, { workerID: h.workerID, key: "next", text: "Resume now" });
  expect(next.resumedFollowups).toEqual([held.messageID]);
  expect(h.messages.filter(message => message.type === "synthetic").map(message => message.id)).toEqual([held.messageID, next.messageID]);
  h.complete();
  await settleWatchers(h);
  await h.reopen().list(h.ownerID);
  expect(h.notices.map(notice => (notice.metadata as { opThreadsFollowup: { messageID: string } }).opThreadsFollowup.messageID).sort())
    .toEqual([held.messageID, next.messageID].sort());
  expect(pendingKeys(h)).toHaveLength(0);
});

test("an identical retry of a held key resumes it", async () => {
  const h = harness();
  h.busy();
  const input = { workerID: h.workerID, key: "retry-held", text: "Held then retried" };
  const held = await h.api.send(h.ownerID, input);
  await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  const retried = await h.reopen().send(h.ownerID, input);
  expect(retried).toEqual({ ...held, resumedFollowups: [held.messageID] });
  expect(h.messages.some(message => message.id === held.messageID)).toBe(true);
  h.complete();
  await settleWatchers(h);
  expect(h.notices).toHaveLength(1);
});

test("a follow-up already running is interrupted and notified, not held", async () => {
  const h = harness();
  const running = await h.api.send(h.ownerID, { workerID: h.workerID, key: "running", text: "Running now" });
  h.busy();
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(stopped.heldFollowups).toEqual([]);
  await settleWatchers(h);
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain(running.messageID);
  expect(h.notices[0]?.text).toContain("interrupted");
});

test("a follow-up promoted between the hold and the interrupt is tracked as interrupted, not held", async () => {
  const h = harness();
  h.busy();
  const raced = await h.api.send(h.ownerID, { workerID: h.workerID, key: "raced", text: "Promoted during the stop" });
  h.beforeInterrupt(() => { h.promoteQueued(); h.busy(); });
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(stopped.heldFollowups).toEqual([]);
  await settleWatchers(h);
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain(raced.messageID);
  expect(h.notices[0]?.text).toContain("interrupted");
});

test("an unadmitted follow-up is held too, and only an explicit send admits it", async () => {
  const h = harness();
  h.reject();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "unadmitted", text: "Never admitted" })).rejects.toThrow("admission rejected");
  h.allow();
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(stopped.heldFollowups).toHaveLength(1);
  await (await ownerContextHook(h.ctx))(h.ownerID);
  await h.reopen().list(h.ownerID);
  expect(h.admitted.size).toBe(0);
  expect(h.wakes()).toBe(0);
  const next = await h.reopen().send(h.ownerID, { workerID: h.workerID, key: "after", text: "Explicit send" });
  expect(next.resumedFollowups).toEqual(stopped.heldFollowups);
  expect(h.admitted.size).toBe(2);
});

test("a held follow-up that another wake promotes is still notified", async () => {
  const h = harness();
  h.busy();
  const held = await h.api.send(h.ownerID, { workerID: h.workerID, key: "elsewhere", text: "Promoted by the worker tab" });
  await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  h.promoteQueued();
  h.complete();
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain(held.messageID);
  expect(pendingKeys(h)).toHaveLength(0);
});

test("interrupt still stops the worker when follow-ups cannot be held, and says so", async () => {
  const h = harness();
  h.busy();
  await h.api.send(h.ownerID, { workerID: h.workerID, key: "unholdable", text: "Storage fails" });
  const broken = threads({ ...h.ctx, storage: { ...h.ctx.storage, scan: async () => { throw new Error("scan unavailable"); } } });
  await expect(broken.interrupt(h.ownerID, { workerID: h.workerID })).rejects.toThrow("could not be held");
  expect(h.interrupts()).toBe(1);
});

test("a malformed follow-up record does not block an interrupt", async () => {
  const h = harness();
  h.busy();
  const queued = await h.api.send(h.ownerID, { workerID: h.workerID, key: "beside-malformed", text: "Valid" });
  h.values.set(`followups/${h.workerID}/malformed`, { bad: true });
  expect((await h.api.interrupt(h.ownerID, { workerID: h.workerID })).heldFollowups).toEqual([queued.messageID]);
  expect(h.values.get(`followups/${h.workerID}/malformed`)).toEqual({ bad: true });
});

test("send reports only held follow-ups it redelivered and names each failure", async () => {
  for (const failure of ["admission", "wake"] as const) {
    const h = harness();
    h.reject();
    await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "held", text: "Held work" })).rejects.toThrow("admission rejected");
    h.allow();
    const [held] = (await h.api.interrupt(h.ownerID, { workerID: h.workerID })).heldFollowups;
    let calls = 0;
    // Fail only the held follow-up's delivery; the new send's own delivery succeeds.
    const flaky = threads({ ...h.ctx, session: { ...h.ctx.session, async synthetic(input: Parameters<Plugin.Context["session"]["synthetic"]>[0]) {
      if (input.id === held && (failure === "admission" || input.resume !== false) && calls++ === 0) throw new Error(`${failure} unavailable ${"x".repeat(500)}`);
      return h.ctx.session.synthetic(input);
    } } as Plugin.Context["session"] });
    const next = await flaky.send(h.ownerID, { workerID: h.workerID, key: `after-${failure}`, text: "Explicit send" });
    expect(next.resumedFollowups).toBeUndefined();
    expect(next.failedFollowups).toHaveLength(1);
    expect(next.failedFollowups![0]!.messageID).toBe(held!);
    expect(next.failedFollowups![0]!.error).toContain(`${failure} unavailable`);
    expect(next.failedFollowups![0]!.error.length).toBeLessThanOrEqual(240);
    expect([...h.values.keys()]).toContain(`followup-pending/${h.ownerID}/${held}`);
    await h.reopen().list(h.ownerID);
    expect(h.messages.some(message => message.id === held)).toBe(true);
  }
});

const syntheticIDs = (h: ReturnType<typeof harness>) =>
  h.messages.filter(message => message.type === "synthetic").map(message => message.id);

test("queue stays the default delivery and never calls the inbox API", async () => {
  const h = harness();
  h.busy();
  const queued = await h.api.send(h.ownerID, { workerID: h.workerID, key: "default", text: "Queued" });
  expect(h.queued()).toEqual([queued.messageID]);
  await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(h.inboxCalls()).toEqual([]);
});

test("steer admits queued, then moves the input to steering so a busy worker takes it at its next step", async () => {
  const h = harness();
  h.busy();
  const wakes = h.wakes();
  const steered = await h.api.send(h.ownerID, { workerID: h.workerID, key: "steer", text: "Stop editing X", delivery: "steer" });
  expect(steered.steerError).toBeUndefined();
  expect(h.inboxCalls()).toEqual(["pending", `steer ${steered.messageID}`]);
  expect(h.admitted.get(steered.messageID)?.delivery).toBe("queue");
  // The steering request itself wakes execution, so no queued wake rings the doorbell.
  expect(h.wakes()).toBe(wakes);
  expect(h.queued()).toEqual([]);
  h.step();
  expect(syntheticIDs(h)).toEqual([steered.messageID]);
  h.complete();
  await settleWatchers(h);
  expect(h.notices).toHaveLength(1);
  expect(pendingKeys(h)).toHaveLength(0);
});

test("steer into an idle worker starts it", async () => {
  const h = harness();
  const steered = await h.api.send(h.ownerID, { workerID: h.workerID, key: "idle-steer", text: "Start", delivery: "steer" });
  expect(syntheticIDs(h)).toEqual([steered.messageID]);
});

test("steer fails before admission when the inbox API is unavailable", async () => {
  const h = harness();
  h.inboxDown();
  await expect(h.api.send(h.ownerID, { workerID: h.workerID, key: "no-inbox", text: "Steer", delivery: "steer" }))
    .rejects.toThrow(inboxUnavailable);
  expect(h.admitted.size).toBe(0);
  expect([...h.values.keys()].filter(key => key.startsWith("followup"))).toEqual([]);
});

test("a steering failure after admission keeps queue delivery and says why", async () => {
  const h = harness();
  h.busy();
  h.failInbox("steer");
  const sent = await h.api.send(h.ownerID, { workerID: h.workerID, key: "fallback", text: "Steer", delivery: "steer" });
  expect(sent.steerError).toBe("steer rejected");
  expect(h.queued()).toEqual([sent.messageID]);
  expect(h.doorbell()).toBe(true);
});

test("an identical steer retry finds the input already steered and does not wake again", async () => {
  const h = harness();
  h.busy();
  const input = { workerID: h.workerID, key: "retry-steer", text: "Steer once", delivery: "steer" as const };
  const first = await h.api.send(h.ownerID, input);
  const calls = h.inboxCalls().length;
  const wakes = h.wakes();
  expect(await h.reopen().send(h.ownerID, input)).toEqual(first);
  expect(h.inboxCalls().slice(calls)).toEqual([`steer ${first.messageID}`]);
  expect(h.steers()).toEqual([first.messageID]);
  expect(h.wakes()).toBe(wakes);
});

test("interrupt returns pending steered input to the queue and holds it until the next send", async () => {
  const h = harness();
  h.busy();
  const steered = await h.api.send(h.ownerID, { workerID: h.workerID, key: "steer-held", text: "Steered", delivery: "steer" });
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID });
  expect(stopped.heldFollowups).toEqual([steered.messageID]);
  expect(h.inboxCalls().at(-1)).toBe(`queue ${steered.messageID}`);
  expect(h.steers()).toEqual([]);
  expect(h.queued()).toEqual([steered.messageID]);
  await (await ownerContextHook(h.ctx))(h.ownerID);
  await h.reopen().list(h.ownerID);
  expect(syntheticIDs(h)).toEqual([]);
  const record = h.values.get(`followups/${h.workerID}/${steered.messageID}`) as { state: string; delivery?: string };
  expect(record.state).toBe("held");
  expect(record.delivery).toBeUndefined();
  const next = await h.reopen().send(h.ownerID, { workerID: h.workerID, key: "after-steer", text: "Next" });
  expect(next.resumedFollowups).toEqual([steered.messageID]);
  expect(syntheticIDs(h)).toEqual([steered.messageID, next.messageID]);
});

test("interrupt with dropHeld cancels queued follow-ups natively and no later send runs them", async () => {
  const h = harness();
  h.busy();
  const dropped = await h.api.send(h.ownerID, { workerID: h.workerID, key: "drop", text: "Never run" });
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID, dropHeld: true });
  expect(stopped.heldFollowups).toEqual([]);
  expect(stopped.droppedFollowups).toEqual([dropped.messageID]);
  expect(stopped.failedDrops).toBeUndefined();
  expect(h.inboxCalls()).toEqual([`cancel ${dropped.messageID}`]);
  expect(h.queued()).toEqual([]);
  expect(pendingKeys(h)).toHaveLength(0);
  await (await ownerContextHook(h.ctx))(h.ownerID);
  const next = await h.reopen().send(h.ownerID, { workerID: h.workerID, key: "after-drop", text: "Next" });
  expect(next.resumedFollowups).toBeUndefined();
  expect(syntheticIDs(h)).toEqual([next.messageID]);
  await expect(h.reopen().send(h.ownerID, { workerID: h.workerID, key: "drop", text: "Never run" }))
    .rejects.toThrow("dropped this follow-up");
  h.complete();
  await settleWatchers(h);
  expect(h.notices.map(notice => notice.text).join()).not.toContain(dropped.messageID);
});

test("dropHeld on an idle worker drops follow-ups an earlier interrupt held", async () => {
  const h = harness();
  h.busy();
  const held = await h.api.send(h.ownerID, { workerID: h.workerID, key: "held-then-drop", text: "Held" });
  expect((await h.api.interrupt(h.ownerID, { workerID: h.workerID })).heldFollowups).toEqual([held.messageID]);
  const dropped = await h.api.interrupt(h.ownerID, { workerID: h.workerID, dropHeld: true });
  expect(dropped.droppedFollowups).toEqual([held.messageID]);
  expect(dropped.heldFollowups).toEqual([]);
  expect(h.queued()).toEqual([]);
});

test("dropHeld also withdraws pending steered input before the stop", async () => {
  const h = harness();
  h.busy();
  const steered = await h.api.send(h.ownerID, { workerID: h.workerID, key: "drop-steer", text: "Steered", delivery: "steer" });
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID, dropHeld: true });
  expect(stopped.droppedFollowups).toEqual([steered.messageID]);
  expect(h.steers()).toEqual([]);
  h.step();
  expect(syntheticIDs(h)).toEqual([]);
});

test("a failed drop still stops the worker and keeps the follow-up held", async () => {
  const h = harness();
  h.busy();
  const held = await h.api.send(h.ownerID, { workerID: h.workerID, key: "undroppable", text: "Held" });
  h.inboxDown();
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID, dropHeld: true });
  expect(h.interrupts()).toBe(1);
  expect(stopped.heldFollowups).toEqual([held.messageID]);
  expect(stopped.droppedFollowups).toEqual([]);
  expect(stopped.failedDrops).toEqual([{ messageID: held.messageID, error: inboxUnavailable.slice(0, 240) }]);
  h.inboxDown(false);
  const next = await h.reopen().send(h.ownerID, { workerID: h.workerID, key: "after-failed-drop", text: "Next" });
  expect(next.resumedFollowups).toEqual([held.messageID]);
});

test("a follow-up promoted before its cancel lands is tracked as interrupted, not dropped", async () => {
  const h = harness();
  h.busy();
  const raced = await h.api.send(h.ownerID, { workerID: h.workerID, key: "drop-race", text: "Promoted first" });
  h.beforeInterrupt(() => {});
  const cancel = h.inbox.cancel;
  h.inbox.cancel = async (sessionID, id) => { h.promoteQueued(); h.busy(); await cancel(sessionID, id); };
  const stopped = await h.api.interrupt(h.ownerID, { workerID: h.workerID, dropHeld: true });
  expect(stopped.droppedFollowups).toEqual([]);
  expect(stopped.heldFollowups).toEqual([]);
  await settleWatchers(h);
  await h.reopen().list(h.ownerID);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]?.text).toContain(raced.messageID);
  expect(h.notices[0]?.text).toContain("interrupted");
});

function withInstructions(h: ReturnType<typeof harness>) {
  const entries = new Map<string, unknown>([["other.entry", "kept"]]);
  const calls: string[] = [];
  const api = threads({ ...h.ctx, session: { ...h.ctx.session, instructions: { entry: {
    async list() { return [...entries].map(([key, value]) => ({ key, value })); },
    async put({ sessionID, key, value }: { sessionID: string; key: string; value: string }) { calls.push(`put ${sessionID} ${key}`); entries.set(key, value); },
    async remove({ sessionID, key }: { sessionID: string; key: string }) { calls.push(`remove ${sessionID} ${key}`); entries.delete(key); },
  } } } } as unknown as typeof h.ctx, 4, h.inbox);
  return { api, entries, calls };
}

test("coordinator rules put and remove instruction entries on the worker", async () => {
  const h = harness();
  const { api, entries, calls } = withInstructions(h);
  const set = await api.setRule(h.ownerID, { workerID: h.workerID, key: "style", text: "Keep commits small" });
  expect(set.rules).toEqual([{ key: "style", text: "Keep commits small" }]);
  expect(entries.get("coordinator-rule.style")).toBe("Keep commits small");
  await api.setRule(h.ownerID, { workerID: h.workerID, key: "a-first", text: "Read docs first" });
  expect((await api.rules(h.ownerID, { workerID: h.workerID })).rules.map(rule => rule.key)).toEqual(["a-first", "style"]);
  const removed = await api.removeRule(h.ownerID, { workerID: h.workerID, key: "style" });
  expect(removed.rules).toEqual([{ key: "a-first", text: "Read docs first" }]);
  expect(entries.get("other.entry")).toBe("kept");
  expect(calls).toEqual([`put ${h.workerID} coordinator-rule.style`, `put ${h.workerID} coordinator-rule.a-first`, `remove ${h.workerID} coordinator-rule.style`]);
});

test("only the owning coordinator may set worker rules", async () => {
  const h = harness();
  const { api, calls } = withInstructions(h);
  const stranger = Session.ID.create();
  await expect(api.setRule(stranger, { workerID: h.workerID, key: "style", text: "x" })).rejects.toThrow("Only the owning coordinator");
  await expect(api.removeRule(stranger, { workerID: h.workerID, key: "style" })).rejects.toThrow("Only the owning coordinator");
  await expect(api.rules(stranger, { workerID: h.workerID })).rejects.toThrow("Only the owning coordinator");
  expect(calls).toEqual([]);
});

test("worker rules explain the OpenCode version they need on older hosts", async () => {
  const h = harness();
  await expect(h.api.setRule(h.ownerID, { workerID: h.workerID, key: "style", text: "x" })).rejects.toThrow("OpenCode 2.2 or later");
  await expect(h.api.rules(h.ownerID, { workerID: h.workerID })).rejects.toThrow("OpenCode 2.2 or later");
});
