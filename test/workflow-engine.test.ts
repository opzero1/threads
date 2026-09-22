import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { workflowEngine } from "../src/workflow-engine";
import { threads, workerIdentity } from "../src/threads";
import { WorkflowStart } from "../src/workflow-types";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function harness(mode: "valid" | "repair" | "missing") {
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
  const ctx = {
    storage,
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`missing ${sessionID}`);
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
        } };
      },
    },
    worktree: { async list() { return []; }, async create() { throw new Error("not used"); } },
  } as unknown as Plugin.Context;
  let api: ReturnType<typeof workflowEngine>;
  let spawns = 0;
  const validationErrors: string[] = [];
  const fakeWorkers = {
    async spawnWorkflow(actor: string, input: { key: string }, _runtime: unknown, metadata: Record<string, unknown>) {
      spawns++;
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
        tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.02,
      });
      let resolve!: () => void;
      waits.set(workerID, new Promise<void>((done) => { resolve = done; }));
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
          sessions.get(workerID)!.outcome = "succeeded";
        } catch (error) {
          validationErrors.push(error instanceof Error ? error.message : String(error));
        } finally {
          resolve();
        }
      });
      return { workerID };
    },
    async reportWorkflow() { return {}; },
    async send() { return {}; },
    async interrupt() { return {}; },
    async prepareWorkflowPrompt() {},
  } as unknown as ReturnType<typeof threads>;
  api = workflowEngine(ctx, fakeWorkers, { maxWorkers: 2 });
  return {
    api, ownerID, directory, deliveries, validationErrors, spawns: () => spawns, file,
    reopen: () => workflowEngine(ctx, fakeWorkers, { maxWorkers: 2 }),
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
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    await reaches(reopened, fixture.ownerID, started.id, "waiting");
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "approval", response: { approved: true } });
    const run = await settled(reopened, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ approved: true });
    expect(run.checkpoints).toEqual([{ key: "approval", prompt: "Continue?", response: { approved: true } }]);
    await reopened.dispose();
  });
});
