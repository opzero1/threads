import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { workflowEngine } from "../src/workflow-engine";
import { authorizeWorkflowExecution, threads, workerIdentity } from "../src/threads";
import { WorkflowAgentInput, WorkflowRun, WorkflowStart } from "../src/workflow-types";
import { withWorkflowSlot, workflowDirectoryPlan } from "../src/workflow-worker";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function harness(mode: "valid" | "repair" | "missing" | "reported-fail" | "manual" | "unmeasured", maxWorkers = 2) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-engine-"));
  temporary.push(directory);
  const file = join(directory, "storage.json");
  let values: Record<string, unknown> = {};
  const flush = async () => Bun.write(file, JSON.stringify(values));
  const storage = {
    async get(key: string) { return structuredClone(values[key]); },
    async set(key: string, value: unknown) { values[key] = structuredClone(value); await flush(); },
    async remove(key: string) { delete values[key]; await flush(); },
    async scan(input: { prefix: string; after?: string; limit?: number }) {
      const keys = Object.keys(values).filter((key) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after)).sort();
      const selected = keys.slice(0, input.limit ?? 100);
      return { entries: selected.map((key) => ({ key, value: structuredClone(values[key]) })), next: keys.length > selected.length ? selected.at(-1) : undefined };
    },
  };
  const ownerID = Session.ID.create();
  const sessions = new Map<string, Record<string, unknown>>();
  sessions.set(ownerID, {
    id: ownerID, projectID: "project", location: { directory },
    permissions: [], metadata: {}, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
  });
  const waits = new Map<string, Promise<void>>();
  const deliveries: string[] = [];
  let profileSystem = "profile-v1";
  const saved = new Map<string, string>();
  const ctx = {
    storage,
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const session = sessions.get(sessionID);
        if (!session) throw { _tag: "Session.NotFoundError", sessionID };
        return session;
      },
      async wait({ sessionID }: { sessionID: string }) { await waits.get(sessionID); },
      async synthetic(input: { id: string; text: string; metadata?: unknown }) {
        deliveries.push(input.id);
        return { id: input.id, payload: { text: input.text, metadata: input.metadata } };
      },
    },
    agent: {
      async get({ agentID }: { agentID: string }) {
        return { data: {
          model: undefined,
          permissions: agentID === "caller"
            ? [{ action: "subagent", resource: "analyst", effect: "allow" }]
            : [{ action: "read", resource: "*", effect: "allow" }],
          system: agentID === "analyst" ? profileSystem : undefined,
        } };
      },
    },
    worktree: { async list() { return []; }, async create() { throw new Error("not used"); } },
  } as unknown as Plugin.Context;
  let api: ReturnType<typeof workflowEngine>;
  let spawns = 0;
  const manual = new Map<string, () => void>();
  const spawnedStepKeys: string[] = [];
  const workerEvents: string[] = [];
  const validationErrors: string[] = [];
  const fakeWorkers = {
    async spawnWorkflow(actor: string, input: { key: string }, _runtime: unknown, metadata: Record<string, unknown>) {
      spawns++;
      workerEvents.push("spawn");
      spawnedStepKeys.push(String(metadata.stepKey));
      const workerID = workerIdentity(actor, input.key);
      const { ownerID: workflowOwnerID, runID, stepKey, callerAgent } = metadata;
      sessions.set(workerID, {
        id: workerID, projectID: "project", location: { directory },
        metadata: {
          opThreads: {
            workerID, coordinatorID: actor, key: input.key, fingerprint: "harness",
            initialMessageID: SessionMessage.ID.create(), reportMessageID: SessionMessage.ID.create(),
          },
          opWorkflow: { ownerID: workflowOwnerID, runID, stepKey, callerAgent },
        },
        ...(mode === "unmeasured" ? {} : {
          tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.02,
        }),
      });
      let resolve!: () => void;
      waits.set(workerID, new Promise<void>((done) => { resolve = done; }));
      if (mode === "manual") {
        manual.set(workerID, resolve);
        return { workerID };
      }
      queueMicrotask(async () => {
        try {
          if (mode === "repair") {
            try {
              await api.result(workerID, { verdict: "PASS", summary: "bad", evidence: [], result: {} });
            } catch (error) {
              validationErrors.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (mode !== "missing") {
            await api.result(workerID, { verdict: "PASS", summary: "checked", evidence: ["native harness"], result: { ok: true } });
          }
          sessions.get(workerID)!.outcome = mode === "reported-fail" ? "failed" : "succeeded";
        } catch (error) {
          validationErrors.push(error instanceof Error ? error.message : String(error));
        } finally {
          resolve();
        }
      });
      return { workerID };
    },
    async reportWorkflow() { return {}; },
    async send() { workerEvents.push("send"); return {}; },
    async interrupt() { return {}; },
    async prepareWorkflowPrompt() {},
  } as unknown as ReturnType<typeof threads>;
  const engine = () => workflowEngine(ctx, fakeWorkers, {
    maxWorkers,
    loadSaved: async (name) => {
      const value = saved.get(name);
      if (value === undefined) throw new Error(`saved workflow ${name} not found`);
      return value;
    },
  });
  api = engine();
  return {
    api, ownerID, directory, deliveries, validationErrors, spawns: () => spawns, file,
    reopen: engine,
    setProfileSystem: (value: string) => { profileSystem = value; },
    setSaved: (name: string, value: string) => { saved.set(name, value); },
    spawnedStepKeys,
    workerEvents,
    deleteWorker: (stepKey: string) => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (found) sessions.delete(found[0]);
    },
    workerID: (stepKey: string) => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (!found) throw new Error(`worker ${stepKey} not found`);
      return found[0];
    },
    mutateRun: async (runID: string, mutate: (run: WorkflowRun) => void) => {
      const key = `workflows/runs/${runID}`;
      const run = WorkflowRun.parse(await storage.get(key));
      mutate(run);
      await storage.set(key, run);
    },
    complete: async (stepKey: string, outcome: "succeeded" | "failed" = "succeeded") => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (!found) throw new Error(`worker ${stepKey} not found`);
      const [workerID, session] = found;
      await api.result(workerID, { verdict: "PASS", summary: "manual", evidence: [stepKey], result: stepKey });
      session.outcome = outcome;
      manual.get(workerID)?.();
    },
  };
}

const script = `
export const meta = { name: "durable-engine", description: "engine harness" };
return await agent("Inspect the durable state", {
  key: "inspect",
  agent: "analyst",
  schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false }
});`;

async function settled(api: ReturnType<typeof workflowEngine>, ownerID: string, runID: string) {
  for (let count = 0; count < 200; count++) {
    const run = await api.get(ownerID, runID);
    if (["completed", "failed", "stopped"].includes(run.status)) return run;
    await Bun.sleep(5);
  }
  throw new Error("workflow did not settle");
}

async function reaches(api: ReturnType<typeof workflowEngine>, ownerID: string, runID: string, status: string) {
  for (let count = 0; count < 200; count++) {
    const run = await api.get(ownerID, runID);
    if (run.status === status) return run;
    await Bun.sleep(5);
  }
  throw new Error(`workflow did not reach ${status}`);
}

describe("durable workflow engine", () => {
  test("journals before dispatch, accepts schema-valid repair, and caches an exact completed key", async () => {
    const fixture = await harness("repair");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "one", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ ok: true });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[0].status === "completed" && run.steps[0].usage).toEqual({ tokens: 24, cost: 0.02, measured: true });
    expect(fixture.validationErrors[0]).toContain("schema validation failed");
    expect(JSON.parse(await Bun.file(fixture.file).text())[`workflows/runs/${run.id}`].status).toBe("completed");
    const retried = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "one", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    expect(retried.id).toBe(run.id);
    expect(fixture.spawns()).toBe(1);
    expect(new Set(fixture.deliveries).size).toBe(1);
    await fixture.api.dispose();
  });

  test("does not promote native success without a workflow report", async () => {
    const fixture = await harness("missing");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "missing", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("without a workflows_result report");
    expect(run.steps[0].status).toBe("failed");
    await fixture.api.dispose();
  });

  test("persists a checkpoint, interrupts on engine disposal, and resumes only after an explicit response", async () => {
    const fixture = await harness("valid");
    const checkpointScript = `
export const meta = { name: "checkpoint", description: "restart harness" };
return await checkpoint("Continue?", { key: "approval" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "restart", script: checkpointScript, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    expect((await reopened.get(fixture.ownerID, started.id)).status).toBe("interrupted");
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "approval", response: { approved: true } });
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ approved: true });
    expect(run.checkpoints).toEqual([{ key: "approval", prompt: "Continue?", response: { approved: true } }]);
    await reopened.dispose();
  });

  test("atomically reserves the maxAgents cap under parallel admission", async () => {
    const fixture = await harness("valid");
    const parallel = `
export const meta = { name: "cap", description: "parallel cap" };
return await parallel([
  () => agent("one", { key: "one", agent: "analyst" }),
  () => agent("two", { key: "two", agent: "analyst" })
]);`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "cap", script: parallel, args: null, maxAgents: 1 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].index).toBe(0);
    await fixture.api.dispose();
  });

  test("cannot complete when script catches a failed worker", async () => {
    const fixture = await harness("missing");
    const catches = `
export const meta = { name: "honest", description: "caught failure" };
try { await agent("missing", { key: "missing", agent: "analyst" }); } catch (_) {}
return "claimed-success";`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "honest", script: catches, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("unresolved step missing (failed)");
    await fixture.api.dispose();
  });

  test("rejects a PASS report when the native worker execution fails", async () => {
    const fixture = await harness("reported-fail");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "native-fail", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.steps[0].status).toBe("failed");
    expect(run.error).toContain("native execution ended failed");
    await fixture.api.dispose();
  });

  test("fails closed when a cached role profile changes after restart", async () => {
    const fixture = await harness("valid");
    const gated = `
export const meta = { name: "profile", description: "profile pin" };
await agent("inspect", { key: "inspect", agent: "analyst" });
return await checkpoint("Continue?", { key: "continue" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "profile", script: gated, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    fixture.setProfileSystem("profile-v2");
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Agent profile for workflow key inspect changed");
    await reopened.dispose();
  });

  test("uses collision-resistant worktree identities and separate owner/run permits", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "plans", script: `export const meta = { name: "plans", description: "plans" }; return null;`, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    const input = WorkflowAgentInput.parse({ key: "write", prompt: "write", agent: "analyst", access: "write", isolation: "worktree" });
    const slash = workflowDirectoryPlan(run, input, "a/b");
    const dash = workflowDirectoryPlan(run, input, "a-b");
    expect(slash.directory).not.toBe(dash.directory);
    expect(slash.directory).toBe(join(slash.parent!, slash.name!));

    const controller = new AbortController();
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const enter = (runID: string) => withWorkflowSlot("owner", 2, runID, 1, controller.signal, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await blocked;
      active--;
    });
    const first = enter("run-a");
    const sameRun = enter("run-a");
    const otherRun = enter("run-b");
    while (active < 2) await Bun.sleep(1);
    expect(maximum).toBe(2);
    release();
    await Promise.all([first, sameRun, otherRun]);
    await fixture.api.dispose();
  });

  test("pause drains a running parallel worker without dispatching queued work, then resumes it", async () => {
    const fixture = await harness("manual");
    const parallel = `
export const meta = { name: "pause", description: "parallel pause" };
return await parallel([
  () => agent("a", { key: "a", agent: "analyst" }),
  () => agent("b", { key: "b", agent: "analyst" })
]);`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "pause", script: parallel, args: null, concurrency: 1 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (fixture.spawnedStepKeys.length < 1) await Bun.sleep(2);
    const firstKey = fixture.spawnedStepKeys[0];
    const secondKey = firstKey === "a" ? "b" : "a";
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "pause" });
    await fixture.complete(firstKey);
    await reaches(fixture.api, fixture.ownerID, started.id, "paused");
    expect(fixture.spawnedStepKeys).toEqual([firstKey]);
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume" });
    while (fixture.spawnedStepKeys.length < 2) await Bun.sleep(2);
    await fixture.complete(secondKey);
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual(["a", "b"]);
    await fixture.api.dispose();
  });

  test("a second engine instance can stop a lease but cannot dispose another instance's run", async () => {
    const fixture = await harness("valid");
    const waiting = `
export const meta = { name: "lease", description: "global lease" };
return await checkpoint("Wait", { key: "wait" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "lease", script: waiting, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    const other = fixture.reopen();
    await other.dispose();
    expect((await fixture.api.get(fixture.ownerID, started.id)).status).toBe("waiting");
    const controller = fixture.reopen();
    const stopped = await controller.control(fixture.ownerID, { runID: started.id, action: "stop" });
    expect(stopped.status).toBe("stopped");
    await fixture.api.dispose();
    await controller.dispose();
  });

  test("replays cached parallel agents in their durable completion order", async () => {
    const fixture = await harness("manual");
    const ordered = `
export const meta = { name: "order", description: "completion order" };
const seen = [];
await parallel([
  () => agent("slow", { key: "a", agent: "analyst" }).then((value) => seen.push(value)),
  () => agent("fast", { key: "b", agent: "analyst" }).then((value) => seen.push(value))
]);
return seen;`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "order", script: ordered, args: null, concurrency: 2 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("a") || !fixture.spawnedStepKeys.includes("b")) await Bun.sleep(2);
    await fixture.complete("b");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    while (fixture.spawnedStepKeys.filter((key) => key === "a").length < 2) await Bun.sleep(2);
    await fixture.complete("a");
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual(["b", "a"]);
    await reopened.dispose();
  });

  test("pins nested workflow source across restart", async () => {
    const fixture = await harness("valid");
    fixture.setSaved("child", `export const meta = { name: "child", description: "v1" }; return "v1";`);
    const parent = `
export const meta = { name: "parent", description: "nested pin" };
const value = await workflow("child");
await checkpoint("Continue?", { key: "continue" });
return value;`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "nested", script: parent, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    fixture.setSaved("child", `export const meta = { name: "child", description: "v2" }; return "v2";`);
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toBe("v1");
    await reopened.dispose();
  });

  test("rejects an existing absolute directory outside the owner project before admission", async () => {
    const fixture = await harness("valid");
    const outsideDirectory = dirname(fixture.directory);
    const outside = `
export const meta = { name: "outside", description: "directory boundary" };
return await agent("inspect", { key: "outside", agent: "analyst", directory: ${JSON.stringify(outsideDirectory)} });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "outside", script: outside, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("inside the owner project");
    expect(run.steps).toHaveLength(0);
    expect(fixture.spawns()).toBe(0);
    await fixture.api.dispose();
  });

  test("fails closed on a token budget after unmeasured native usage", async () => {
    const fixture = await harness("unmeasured");
    const budgeted = `
export const meta = { name: "budget", description: "unmeasured budget" };
await agent("first", { key: "first", agent: "analyst" });
return await agent("second", { key: "second", agent: "analyst" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "budget", script: budgeted, args: null, tokenBudget: 100 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("prior worker usage is unmeasured");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].status === "completed" && run.steps[0].usage.measured).toBe(false);
    await fixture.api.dispose();
  });

  test("re-establishes a restarted read worker before sending its stable repair follow-up", async () => {
    const fixture = await harness("manual");
    const read = `
export const meta = { name: "read-retry", description: "role initialization" };
return await agent("read", { key: "read", agent: "analyst" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "read-retry", script: read, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("read")) await Bun.sleep(2);
    await fixture.api.dispose();
    await fixture.mutateRun(started.id, (run) => {
      const step = run.steps[0];
      run.steps[0] = { ...step, status: "failed", error: "native failure", retryable: true };
      run.status = "interrupted";
    });
    fixture.workerEvents.length = 0;
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    while (!fixture.workerEvents.includes("send")) await Bun.sleep(2);
    expect(fixture.workerEvents.slice(0, 2)).toEqual(["spawn", "send"]);
    await fixture.complete("read");
    expect((await settled(reopened, fixture.ownerID, started.id)).status).toBe("completed");
    await reopened.dispose();
  });

  test("returns a completed cached write without recreating its deleted native session", async () => {
    const fixture = await harness("valid");
    const writeThenWait = `
export const meta = { name: "cached-write", description: "deleted session" };
const result = await agent("write", { key: "write", agent: "analyst", access: "write" });
await checkpoint("Continue?", { key: "continue" });
return result;`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "cached-write", script: writeThenWait, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    expect(fixture.spawns()).toBe(1);
    await fixture.api.dispose();
    fixture.deleteWorker("write");
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ ok: true });
    expect(fixture.spawns()).toBe(1);
    await reopened.dispose();
  });

  test("does not recreate a missing previously-dispatched write worker", async () => {
    const fixture = await harness("manual");
    const write = `
export const meta = { name: "missing-write", description: "ambiguous dispatch" };
return await agent("write", { key: "write", agent: "analyst", access: "write" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "missing-write", script: write, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("write")) await Bun.sleep(2);
    await fixture.api.dispose();
    fixture.deleteWorker("write");
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    const run = await reaches(reopened, fixture.ownerID, started.id, "interrupted");
    expect(run.error).toContain("external state is ambiguous");
    expect(run.steps[0].status).toBe("running");
    expect(fixture.spawns()).toBe(1);
    await reopened.dispose();
  });

  test("blocks automatic worker context restoration without a live lease or explicit authorization", async () => {
    const fixture = await harness("manual");
    const read = `
export const meta = { name: "context-gate", description: "restart gate" };
return await agent("read", { key: "read", agent: "analyst" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "context-gate", script: read, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("read")) await Bun.sleep(2);
    const workerID = fixture.workerID("read");
    await expect(fixture.api.prepareContext(workerID)).resolves.toBeUndefined();
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    await expect(reopened.prepareContext(workerID)).rejects.toThrow("explicitly resumed");
    authorizeWorkflowExecution(workerID);
    await expect(reopened.prepareContext(workerID)).resolves.toBeUndefined();
    expect((await reopened.get(fixture.ownerID, started.id)).status).toBe("interrupted");
    await reopened.dispose();
  });

  test("a checkpoint reached while draining pause cannot erase pause intent", async () => {
    const fixture = await harness("manual");
    const checkpointAfterAgent = `
export const meta = { name: "pause-checkpoint", description: "pause intent" };
await agent("read", { key: "read", agent: "analyst" });
return await checkpoint("Continue?", { key: "continue" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "pause-checkpoint", script: checkpointAfterAgent, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("read")) await Bun.sleep(2);
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "pause" });
    await fixture.complete("read");
    let paused = await reaches(fixture.api, fixture.ownerID, started.id, "paused");
    for (let count = 0; count < 100 && paused.checkpoints.length === 0; count++) {
      await Bun.sleep(2);
      paused = await fixture.api.get(fixture.ownerID, started.id);
    }
    expect(paused.status).toBe("paused");
    expect(paused.checkpoints).toEqual([{ key: "continue", prompt: "Continue?" }]);
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: "yes" });
    expect((await settled(fixture.api, fixture.ownerID, started.id)).result).toBe("yes");
    await fixture.api.dispose();
  });

  test("recovers a crash during stopping as a sticky stopped run", async () => {
    const fixture = await harness("manual");
    const read = `
export const meta = { name: "sticky-stop", description: "stop recovery" };
return await agent("read", { key: "read", agent: "analyst" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "sticky-stop", script: read, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("read")) await Bun.sleep(2);
    await fixture.api.dispose();
    await fixture.mutateRun(started.id, (run) => {
      run.status = "stopping";
      run.delivered = false;
    });
    const reopened = fixture.reopen();
    const run = await reopened.get(fixture.ownerID, started.id);
    expect(run.status).toBe("stopped");
    await expect(reopened.control(fixture.ownerID, { runID: started.id, action: "resume" })).rejects.toThrow("Cannot resume");
    expect(fixture.spawns()).toBe(1);
    await reopened.dispose();
  });

  test("paused queued work releases the owner permit for another run", async () => {
    const fixture = await harness("manual", 1);
    const parallel = `
export const meta = { name: "permit-a", description: "paused queue" };
return await parallel([
  () => agent("a", { key: "a", agent: "analyst" }),
  () => agent("b", { key: "b", agent: "analyst" })
]);`;
    const first = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "permit-a", script: parallel, args: null, concurrency: 1 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (fixture.spawnedStepKeys.length < 1) await Bun.sleep(2);
    const activeKey = fixture.spawnedStepKeys[0];
    await fixture.api.control(fixture.ownerID, { runID: first.id, action: "pause" });
    await fixture.complete(activeKey);
    await reaches(fixture.api, fixture.ownerID, first.id, "paused");

    const secondScript = `
export const meta = { name: "permit-b", description: "other run" };
return await agent("c", { key: "c", agent: "analyst" });`;
    const second = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "permit-b", script: secondScript, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    for (let count = 0; count < 100 && !fixture.spawnedStepKeys.includes("c"); count++) await Bun.sleep(2);
    expect(fixture.spawnedStepKeys).toContain("c");
    await fixture.complete("c");
    expect((await settled(fixture.api, fixture.ownerID, second.id)).status).toBe("completed");
    await fixture.api.control(fixture.ownerID, { runID: first.id, action: "stop" });
    await fixture.api.dispose();
  });

  test("serializes concurrent final delivery attempts", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "delivery", script: `export const meta = { name: "delivery", description: "single delivery" }; return true;`, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await settled(fixture.api, fixture.ownerID, started.id);
    await fixture.mutateRun(started.id, (run) => { run.delivered = false; });
    const before = fixture.deliveries.length;
    await Promise.all([
      fixture.api.get(fixture.ownerID, started.id),
      fixture.api.get(fixture.ownerID, started.id),
      fixture.api.get(fixture.ownerID, started.id),
    ]);
    expect(fixture.deliveries.length).toBe(before + 1);
    await fixture.api.dispose();
  });
});
