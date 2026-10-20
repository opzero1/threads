import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { workflowEngine } from "../src/workflow-engine";
import { authorizeWorkflowExecution, serialized, threads, workerIdentity } from "../src/threads";
import { WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES, WorkflowAgentInput, WorkflowRun, WorkflowStart } from "../src/workflow-types";
import { withWorkflowSlot, workflowDirectoryPlan } from "../src/workflow-worker";
import type { CheckoutState } from "../src/workflow-cleanup";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

type WorktreeLayout = { cleanupWorktrees?: boolean };

async function harness(mode: "valid" | "repair" | "missing" | "reported-fail" | "manual" | "move-idle" | "unmeasured" | "timeout-race" | "timeout-reject" | "large-error", maxWorkers = 2, layout?: WorktreeLayout) {
  const root = await mkdtemp(join(tmpdir(), "workflow-engine-"));
  temporary.push(root);
  // With a layout, worktrees are real directories under the temporary root and stay registered until removed.
  const directory = layout ? join(root, "project") : root;
  if (layout) await mkdir(directory);
  const file = join(directory, "storage.json");
  let values: Record<string, unknown> = {};
  const writes: string[] = [];
  let readGate: { key: string; entered: () => void; wait: Promise<void> } | undefined;
  const flush = async () => Bun.write(file, JSON.stringify(values));
  const storage = {
    async get(key: string) {
      const value = structuredClone(values[key]);
      if (readGate?.key === key) {
        const gate = readGate;
        readGate = undefined;
        gate.entered();
        await gate.wait;
      }
      return value;
    },
    async set(key: string, value: unknown) { writes.push(key); values[key] = structuredClone(value); await flush(); },
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
  const deliveryTexts: string[] = [];
  let deliveryFailures = 0;
  let profileSystem = "profile-v1";
  let profilePermissions: unknown[] = [{ action: "read", resource: "*", effect: "allow" }];
  const saved = new Map<string, string>();
  const worktreeProjects: string[] = [];
  const registered = new Map<string, string>();
  const removals: { projectID: string; directory: string; force: boolean }[] = [];
  const inspections: string[] = [];
  const agentLocations: string[] = [];
  let checkoutState: (directory: string, signal?: AbortSignal) => CheckoutState | Promise<CheckoutState> = () => "clean";
  let removalRefusal: (directory: string) => "dirty" | "fail" | undefined = () => undefined;
  let beforeReserve: () => Promise<void> = async () => {};
  let worktreeGate: { entered: () => void; wait: Promise<void> } | undefined;
  const ctx = {
    storage,
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const session = sessions.get(sessionID);
        if (!session) throw { _tag: "Session.NotFoundError", sessionID };
        return session;
      },
      async wait({ sessionID }: { sessionID: string }) {
        if (mode === "move-idle") {
          await api.result(sessionID, { verdict: "PASS", summary: "write completed", evidence: ["worktree"], result: { ok: true } });
          manual.get(sessionID)?.();
        }
        await waits.get(sessionID);
      },
      async synthetic(input: { id: string; text: string; metadata?: unknown }) {
        deliveries.push(input.id);
        deliveryTexts.push(input.text);
        if (deliveryFailures > 0) {
          deliveryFailures--;
          throw new Error("Synthetic delivery acknowledgement lost");
        }
        return { id: input.id, payload: { text: input.text, metadata: input.metadata } };
      },
    },
    agent: {
      async get({ agentID, location }: { agentID: string; location?: { directory?: string } }) {
        if (location?.directory) agentLocations.push(location.directory);
        return { data: {
          model: undefined,
          permissions: agentID === "caller"
            ? [{ action: "subagent", resource: "analyst", effect: "allow" }]
            : profilePermissions,
          system: agentID === "analyst" ? profileSystem : undefined,
        } };
      },
    },
    worktree: {
      async list(input: { projectID: string }) {
        return layout ? [...registered].filter(([, projectID]) => projectID === input.projectID).map(([directory]) => ({ directory })) : [];
      },
      async create(input: { projectID: string; directory: string; name: string }) {
        worktreeProjects.push(input.projectID);
        if (worktreeGate) {
          const gate = worktreeGate;
          worktreeGate = undefined;
          gate.entered();
          await gate.wait;
        }
        const created = join(input.directory, input.name);
        if (layout) {
          await mkdir(created, { recursive: true });
          registered.set(created, input.projectID);
        }
        return { directory: created };
      },
      async remove(input: { projectID: string; directory: string; force: boolean }) {
        removals.push(structuredClone(input));
        if (registered.get(input.directory) !== input.projectID) throw new Error(`Invalid worktree directory: ${input.directory}`);
        const refusal = removalRefusal(input.directory);
        if (refusal === "dirty") throw Object.assign(new Error(`'${input.directory}' contains modified or untracked files, use --force to delete it`), { _tag: "Git.WorktreeError", forceRequired: true });
        if (refusal === "fail") throw new Error("worktree removal failed");
        registered.delete(input.directory);
        await rm(input.directory, { recursive: true, force: true });
      },
    },
  } as unknown as Plugin.Context;
  let api: ReturnType<typeof workflowEngine>;
  let spawns = 0;
  const manual = new Map<string, () => void>();
  const rejected = new Map<string, (reason: Error) => void>();
  const spawnedStepKeys: string[] = [];
  const spawnWaiters = new Map<string, (() => void)[]>();
  const workerEvents: string[] = [];
  const validationErrors: string[] = [];
  const reservations: string[] = [];
  const spawnInputs: { key: string; directory?: string; paths?: string[] }[] = [];
  const spawnScopes: { granted: unknown; isolation: unknown }[] = [];
  const fakeWorkers = {
    async reserveWorkflow(_actor: string, input: { key: string }) {
      reservations.push(input.key);
      await beforeReserve();
      return layout ? "project" : "source-project";
    },
    async spawnWorkflow(actor: string, input: { key: string }, _runtime: unknown, metadata: Record<string, unknown>) {
      spawns++;
      spawnInputs.push(structuredClone(input));
      spawnScopes.push({ granted: metadata.granted, isolation: metadata.isolation });
      workerEvents.push("spawn");
      spawnedStepKeys.push(String(metadata.stepKey));
      const workerID = workerIdentity(actor, input.key);
      if (sessions.has(workerID)) {
        if (sessions.get(workerID)!.outcome !== undefined) waits.set(workerID, Promise.resolve());
        return { workerID };
      }
      const { ownerID: workflowOwnerID, runID, stepKey, callerAgent } = metadata;
      sessions.set(workerID, {
        id: workerID, projectID: "project", location: { directory },
        ...(mode === "move-idle" ? { outcome: "succeeded" } : {}),
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
      const wait = new Promise<void>((done, reject) => { resolve = done; rejected.set(workerID, reject); });
      void wait.catch(() => {});
      waits.set(workerID, wait);
      for (const notify of spawnWaiters.get(String(stepKey)) ?? []) notify();
      spawnWaiters.delete(String(stepKey));
      if (mode === "manual" || mode === "move-idle" || mode === "timeout-race" || mode === "timeout-reject" || mode === "large-error") {
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
    async send(_actor: string, input: { workerID: string }) {
      workerEvents.push("send");
      if (mode === "manual") {
        let resolve!: () => void;
        waits.set(input.workerID, new Promise<void>((done) => { resolve = done; }));
        manual.set(input.workerID, resolve);
        delete sessions.get(input.workerID)!.outcome;
      }
      return {};
    },
    async interrupt(_actor: string, input: { workerID: string }) {
      workerEvents.push("interrupt-start");
      if (mode === "timeout-race" || mode === "timeout-reject") {
        sessions.get(input.workerID)!.outcome = "interrupted";
        if (mode === "timeout-reject") rejected.get(input.workerID)?.(new Error("native wait interrupted"));
        else manual.get(input.workerID)?.();
        await Bun.sleep(20);
      }
      workerEvents.push("interrupt-end");
      return {};
    },
    async prepareWorkflowPrompt() {},
  } as unknown as ReturnType<typeof threads>;
  const engine = () => workflowEngine(ctx, fakeWorkers, {
    maxWorkers,
    ...(layout ? {
      cleanupWorktrees: layout.cleanupWorktrees ?? true,
      inspectCheckout: async (checkout: string, signal?: AbortSignal) => {
        inspections.push(checkout);
        return checkoutState(checkout, signal);
      },
    } : {}),
    loadSaved: async (name) => {
      const value = saved.get(name);
      if (value === undefined) throw new Error(`saved workflow ${name} not found`);
      return value;
    },
  });
  api = engine();
  return {
    registered, removals, inspections, agentLocations,
    holdWorker: (stepKey: string) => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (!found) throw new Error(`worker ${stepKey} not found`);
      let release!: () => void;
      waits.set(found[0], new Promise<void>((resolve) => { release = resolve; }));
      return () => release();
    },
    setCheckoutState: (value: typeof checkoutState) => { checkoutState = value; },
    setRemovalRefusal: (value: typeof removalRefusal) => { removalRefusal = value; },
    setBeforeReserve: (value: typeof beforeReserve) => { beforeReserve = value; },
    api, ownerID, directory, deliveries, deliveryTexts, writes, validationErrors, worktreeProjects, reservations, spawnInputs, spawnScopes, spawns: () => spawns, file,
    reopen: engine,
    failDeliveries: (count: number) => { deliveryFailures = count; },
    setProfileSystem: (value: string) => { profileSystem = value; },
    setProfilePermissions: (value: unknown[]) => { profilePermissions = value; },
    setOwnerPermissions: (value: unknown[]) => { sessions.get(ownerID)!.permissions = value; },
    setRestartNotice: (workerID: string) => {
      const session = sessions.get(workerID)!;
      session.metadata = { ...(session.metadata as Record<string, unknown>), notice: "restart" };
    },
    setSaved: (name: string, value: string) => { saved.set(name, value); },
    spawnedStepKeys,
    waitForSpawn: (stepKey: string) => spawnedStepKeys.includes(stepKey)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        spawnWaiters.set(stepKey, [...(spawnWaiters.get(stepKey) ?? []), resolve]);
      }),
    workerEvents,
    blockWorktreeCreation: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      worktreeGate = { entered, wait };
      return { started, release };
    },
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
    setStorage: (key: string, value: unknown) => storage.set(key, value),
    getStorage: (key: string) => storage.get(key),
    blockStorageRead: (key: string) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      readGate = { key, entered, wait };
      return { started, release };
    },
    failWorkers: (message: string) => { for (const reject of rejected.values()) reject(new Error(message)); },
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
    report: async (stepKey: string, outcome: "succeeded" | "failed" = "succeeded") => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (!found) throw new Error(`worker ${stepKey} not found`);
      const [workerID, session] = found;
      await api.result(workerID, { verdict: "PASS", summary: "manual", evidence: [stepKey], result: { ok: true } });
      session.outcome = outcome;
    },
    setOutcome: (stepKey: string, outcome: "succeeded" | "failed") => {
      const found = [...sessions.entries()].find(([, session]) =>
        (session.metadata as { opWorkflow?: { stepKey?: string } } | undefined)?.opWorkflow?.stepKey === stepKey
      );
      if (!found) throw new Error(`worker ${stepKey} not found`);
      found[1].outcome = outcome;
      manual.get(found[0])?.();
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
  let latest: WorkflowRun | undefined;
  for (let count = 0; count < 200; count++) {
    const run = await api.get(ownerID, runID);
    latest = run;
    if (["completed", "failed", "stopped"].includes(run.status)) return run;
    await Bun.sleep(5);
  }
  throw new Error(`workflow did not settle: ${JSON.stringify({ runID, status: latest?.status, error: latest?.error, logs: latest?.logs.length, steps: latest?.steps.map((step) => ({ key: step.key, status: step.status })), limits: latest?.limits })}`);
}

async function reaches(api: ReturnType<typeof workflowEngine>, ownerID: string, runID: string, status: string) {
  let latest: WorkflowRun | undefined;
  for (let count = 0; count < 200; count++) {
    latest = await api.get(ownerID, runID);
    if (latest.status === status) return latest;
    await Bun.sleep(5);
  }
  throw new Error(`workflow did not reach ${status}; last state was ${latest?.status}: ${latest?.error ?? "no error"}`);
}

describe("durable workflow engine", () => {
  test("fresh worktree worker waits for its task despite an earlier move idle outcome", async () => {
    const fixture = await harness("move-idle");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "move-idle", script: script.replace('agent: "analyst",', 'agent: "analyst", access: "write", isolation: "worktree",'),
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      const completed = await settled(fixture.api, fixture.ownerID, started.id);
      expect(completed.status).toBe("completed");
      expect(completed.result).toEqual({ ok: true });
      expect(fixture.spawns()).toBe(1);
      expect(fixture.workerEvents).toEqual(["spawn"]);
    } finally { await fixture.api.dispose(); }
  });
  for (const boundary of ["dispose", "recover"] as const) {
    test(`lifecycle provenance: ${boundary} persists typed cause and resume clears it`, async () => {
      const fixture = await harness("valid");
      let reopened: ReturnType<typeof workflowEngine> | undefined;
      try {
        const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: `provenance-${boundary}`, script: `export const meta = { name: "provenance", description: "inspection" }; return await checkpoint("Inspect", { key: "inspect", reviewer: "coordinator" });` }), { agent: "caller", model: { providerID: "test", id: "model" } });
        const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
        await fixture.api.dispose();
        if (boundary === "recover") await fixture.setStorage(`workflows/runs/${started.id}`, waiting);
        reopened = fixture.reopen();
        const interrupted = await reopened.get(fixture.ownerID, started.id);
        expect(interrupted.interruption).toEqual({ kind: boundary === "dispose" ? "engine-disposed" : "lease-lost", priorStatus: "waiting", at: expect.any(Number) });
        await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "inspect", response: true });
        expect((await settled(reopened, fixture.ownerID, started.id)).interruption).toBeUndefined();
      } finally { await reopened?.dispose(); await fixture.api.dispose(); }
    });
  }
  for (const status of ["pausing", "paused", "stopping", "stopped"] as const) {
    test(`lifecycle provenance: disposal and recovery preserve ${status} intent`, async () => {
      const fixture = await harness("valid");
      let reopened: ReturnType<typeof workflowEngine> | undefined;
      try {
        const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: `intent-${status}`, script: `export const meta = { name: "intent", description: "control" }; return await checkpoint("Inspect", { key: "inspect", reviewer: "coordinator" });` }), { agent: "caller", model: { providerID: "test", id: "model" } });
        await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
        await fixture.mutateRun(started.id, (run) => { run.status = status; });
        await fixture.api.dispose();
        reopened = fixture.reopen();
        const recovered = await reopened.get(fixture.ownerID, started.id);
        expect(recovered.status).toBe(status === "pausing" ? "paused" : status === "stopping" ? "stopped" : status);
        expect(recovered.interruption).toBeUndefined();
        expect(fixture.spawns()).toBe(0);
      } finally { await reopened?.dispose(); await fixture.api.dispose(); }
    });
  }
  for (const boundary of ["checkpoint", "dispose", "recover"] as const) {
    test(`owner liveness: ${boundary} delivers exact run/checkpoint and explicit-resume guidance`, async () => {
      const fixture = await harness("valid");
      let reopened: ReturnType<typeof workflowEngine> | undefined;
      try {
        const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
          key: `owner-liveness-${boundary}`,
          script: `export const meta = { name: "owner-liveness", description: "Human approval remains unanswered" };
return await checkpoint("Approve the next phase?", { key: "human-approval" });`,
          args: null,
        }), { agent: "caller", model: { providerID: "test", id: "model" } });
        const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
        expect(waiting.checkpoints.map(({ key, prompt }) => ({ key, prompt }))).toEqual([{ key: "human-approval", prompt: "Approve the next phase?" }]);
        if (boundary !== "checkpoint") {
          await fixture.api.dispose();
          if (boundary === "recover") {
            // Retain the durable waiting snapshot, as a process crash would.
            await fixture.setStorage(`workflows/runs/${started.id}`, waiting);
            fixture.deliveries.length = 0;
            fixture.deliveryTexts.length = 0;
          }
          reopened = fixture.reopen();
        }
        const observed = await (reopened ?? fixture.api).get(fixture.ownerID, started.id);
        expect(observed.status).toBe(boundary === "checkpoint" ? "waiting" : "interrupted");
        expect(observed.checkpoints[0].response).toBeUndefined();
        expect(observed.result).toBeUndefined();
        expect(fixture.spawns()).toBe(0);
        console.log(JSON.stringify({ boundary, runID: started.id, status: observed.status,
          checkpoints: observed.checkpoints, deliveries: fixture.deliveries, deliveryTexts: fixture.deliveryTexts }));
        // Match the requested boundary, not an earlier checkpoint notice.
        const notice = fixture.deliveryTexts.find((text) => text.includes(started.id) && text.includes("human-approval") &&
          (boundary === "checkpoint" ? /checkpoint requires/i.test(text) : /interrupted/i.test(text)));
        expect(notice, `Owner needs a synthetic ${boundary} notice naming the exact run and unanswered checkpoint`).toBeDefined();
        expect(notice).toContain("Approve the next phase?");
        expect(notice).toMatch(/resume/i);
        expect(notice).toMatch(/explicit|response/i);
        if (boundary !== "checkpoint") expect(notice).toMatch(/interrupt|restart|stopped/i);
        expect(fixture.deliveries.length).toBeGreaterThan(0);
      } finally {
        await reopened?.dispose();
        await fixture.api.dispose();
      }
    });
  }

  test("owner liveness: expired resume interrupts retained executing worker", async () => {
    const fixture = await harness("manual");
    const timeoutMs = 86_400_000;
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "expired", script, timeoutMs }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      for (let count = 0; count < 200 && fixture.spawns() === 0; count++) await Bun.sleep(5);
      expect(fixture.spawns()).toBe(1);
      await fixture.api.dispose();
      await fixture.mutateRun(started.id, (run) => { run.created = Date.now() - timeoutMs - 1; });
      fixture.workerEvents.length = 0;
      reopened = fixture.reopen();
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
      const failed = await settled(reopened, fixture.ownerID, started.id);
      expect(failed.error).toBe("Workflow timeout exceeded");
      expect(failed.steps[0].status).toBe("running");
      expect(fixture.workerEvents).toContain("interrupt-end");
      expect(fixture.spawns()).toBe(1);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("owner liveness: ambiguous delivery retries its ID, recovery and inspection deduplicate", async () => {
    const fixture = await harness("valid");
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      fixture.failDeliveries(100);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "retry-notice",
        script: `export const meta = { name: "retry", description: "retry" }; return await checkpoint("Approval?", { key: "approve" });`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      expect(waiting.error).toBeUndefined();
      expect(waiting.checkpoints[0].response).toBeUndefined();
      expect(waiting.attention?.checkpoints ?? []).toEqual([]);
      fixture.failDeliveries(0);
      await fixture.api.get(fixture.ownerID, started.id);
      const checkpointIDs = fixture.deliveries.filter((_, index) => /checkpoint requires/.test(fixture.deliveryTexts[index]));
      expect(checkpointIDs.length).toBeGreaterThan(1);
      expect(new Set(checkpointIDs).size).toBe(1);
      fixture.failDeliveries(100);
      await fixture.api.dispose();
      const interrupted = WorkflowRun.parse(await fixture.getStorage(`workflows/runs/${started.id}`));
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.attention?.deliveredInterruption).toBe(0);
      fixture.failDeliveries(1);
      reopened = fixture.reopen();
      await reopened.get(fixture.ownerID, started.id);
      await reopened.get(fixture.ownerID, started.id);
      const interruptionIDs = fixture.deliveries.filter((_, index) => /interrupted:/.test(fixture.deliveryTexts[index]));
      expect(interruptionIDs.length).toBeGreaterThan(1);
      expect(new Set(interruptionIDs).size).toBe(1);
      const before = fixture.deliveries.length;
      const writes = fixture.writes.length;
      await Promise.all([reopened.get(fixture.ownerID, started.id), reopened.list(fixture.ownerID), fixture.api.get(fixture.ownerID, started.id)]);
      const another = fixture.reopen();
      try { await another.get(fixture.ownerID, started.id); } finally { await another.dispose(); }
      expect(fixture.deliveries.length).toBe(before);
      expect(fixture.writes.length).toBe(writes);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("owner liveness: teardown retains a pending notice instead of admitting into a stopping service", async () => {
    const fixture = await harness("valid");
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "shutdown-notice",
        script: `export const meta = { name: "shutdown", description: "shutdown" }; return await checkpoint("Approval?", { key: "approve" });`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      const delivered = fixture.deliveries.length;
      await fixture.api.dispose();
      const retained = WorkflowRun.parse(await fixture.getStorage(`workflows/runs/${started.id}`));
      expect(retained.status).toBe("interrupted");
      expect(retained.attention?.interruption).toBe(1);
      expect(retained.attention?.deliveredInterruption).toBe(0);
      expect(fixture.deliveries).toHaveLength(delivered);
      reopened = fixture.reopen();
      const recovered = await reopened.get(fixture.ownerID, started.id);
      expect(recovered.attention?.deliveredInterruption).toBe(1);
      expect(fixture.deliveries).toHaveLength(delivered + 1);
      await reopened.get(fixture.ownerID, started.id);
      expect(fixture.deliveries).toHaveLength(delivered + 1);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("owner liveness: distinct repeated interruptions do not duplicate checkpoint notices", async () => {
    const fixture = await harness("valid");
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "repeat-notice",
        script: `export const meta = { name: "repeat", description: "repeat" }; return await checkpoint("Approval?", { key: "approve" });`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      await fixture.api.dispose();
      reopened = fixture.reopen();
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
      await reaches(reopened, fixture.ownerID, started.id, "waiting");
      await reopened.dispose();
      const retained = WorkflowRun.parse(await fixture.getStorage(`workflows/runs/${started.id}`));
      expect(retained.attention?.interruption).toBe(2);
      expect(retained.attention?.deliveredInterruption).toBe(1);
      reopened = fixture.reopen();
      const run = await reopened.get(fixture.ownerID, started.id);
      expect(run.attention).toEqual({ checkpoints: ["approve"], interruption: 2, deliveredInterruption: 2 });
      const interruptions = fixture.deliveries.filter((_, index) => /interrupted:/.test(fixture.deliveryTexts[index]));
      expect(interruptions).toHaveLength(2);
      expect(new Set(interruptions).size).toBe(2);
      expect(fixture.deliveryTexts.filter((text) => /checkpoint requires/.test(text))).toHaveLength(1);
      expect(run.checkpoints[0].response).toBeUndefined();
      expect(run.result).toBeUndefined();
      expect(fixture.spawns()).toBe(0);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("owner liveness: already answered checkpoint has no pending notice on recovery", async () => {
    const fixture = await harness("valid");
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "answered-notice",
        script: `export const meta = { name: "answered", description: "answered" }; return await checkpoint("Approval?", { key: "approve" });`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      await fixture.api.dispose();
      await fixture.mutateRun(started.id, (run) => {
        delete run.attention;
        run.checkpoints[0].response = false;
        run.settlements = [{ kind: "checkpoint", key: "approve", response: false }];
      });
      fixture.deliveries.length = 0;
      fixture.deliveryTexts.length = 0;
      reopened = fixture.reopen();
      const run = await reopened.get(fixture.ownerID, started.id);
      expect(run.checkpoints[0].response).toBe(false);
      expect(fixture.deliveryTexts).toHaveLength(1);
      expect(fixture.deliveryTexts[0]).toContain("interrupted:");
      expect(fixture.deliveryTexts[0]).not.toContain("Checkpoint");
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
      expect((await settled(reopened, fixture.ownerID, started.id)).result).toBe(false);
      expect(fixture.deliveryTexts.some((text) => /checkpoint requires/.test(text))).toBe(false);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

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
    expect(run.steps[0].status === "completed" && run.steps[0].usage).toEqual({ tokens: 18, cost: 0.02, measured: true });
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

  test("persists failure when the workflow result exceeds its durable output limit", async () => {
    const fixture = await harness("valid");
    const input = "x".repeat(600_000);
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "oversized-result",
      script: `export const meta = { name: "oversized", description: "oversized result" }; return args + args;`,
      args: input,
    }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });

    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Workflow execution was truncated");
    expect(run.args).toBe(input);
    expect(run.result).toBeUndefined();
    expect(JSON.parse(await Bun.file(fixture.file).text())[`workflows/runs/${run.id}`].status).toBe("failed");
    await fixture.api.dispose();
  });

  test("persisted helper policy survives restart and nested saved replay; omitted records stay legacy", async () => {
    for (const legacy of [false, true]) {
      const fixture = await harness("valid");
      const child = `export const meta = { name: "child", description: "helper policy replay" };
        let retries = 0;
        let gates = 0;
        try { await retry((index) => { retries = index; if (index < 6) throw new Error("again"); return index; }); } catch (error) {}
        try { await gate((index) => { gates = index; return index; }, (value) => value === 6); } catch (error) {}
        let rounds = 0;
        const found = await loopUntilDry({key:"id", round:(index) => { rounds = index; return index <= 12 ? [{id:index}] : []; }});
        await checkpoint("Continue?", {key:"approval"});
        return { retries, gates, rounds, found:found.length };`;
      fixture.setSaved("child", child);
      fixture.setSaved("parent", `export const meta = { name: "parent", description: "saved policy" };
        let parentRetries = 0;
        try { await retry((index) => { parentRetries = index; if (index < 6) throw new Error("again"); return index; }); } catch (error) {}
        return {parentRetries, child:await workflow("child")};`);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({key:"helper-replay", name:"parent", args:null}), {
        agent:"caller", model:{providerID:"test", id:"model"},
      });
      expect(started.helperPolicy).toBe("optional-counts");
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      await fixture.api.dispose();
      const key = `workflows/runs/${started.id}`;
      const persisted = JSON.parse(await Bun.file(fixture.file).text())[key];
      expect(persisted.helperPolicy).toBe("optional-counts");
      if (legacy) {
        delete persisted.helperPolicy;
        await fixture.setStorage(key, persisted);
      }
      fixture.setSaved("child", `export const meta = { name: "changed", description: "must stay pinned" }; throw new Error("unpinned child");`);
      const reopened = fixture.reopen();
      try {
        expect((await reopened.get(fixture.ownerID, started.id)).helperPolicy).toBe(legacy ? "legacy-bounded" : "optional-counts");
        await reopened.control(fixture.ownerID, {runID:started.id, action:"resume", checkpointKey:"workflow:child:0/approval", response:true});
        const completed = await settled(reopened, fixture.ownerID, started.id);
        expect(completed.status).toBe("completed");
        expect(completed.result).toEqual(legacy
          ? {parentRetries:3, child:{retries:3, gates:3, rounds:10, found:10}}
          : {parentRetries:6, child:{retries:6, gates:6, rounds:14, found:12}});
        expect(JSON.parse(await Bun.file(fixture.file).text())[key].helperPolicy).toBe(legacy ? "legacy-bounded" : "optional-counts");
      } finally { await reopened.dispose(); }
    }
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

  test("omitted budgets allow more than four steps and 132 host calls, including exact retry", async () => {
    const fixture = await harness("valid");
    const input = WorkflowStart.parse({ key: "unbounded", script: `
export const meta = { name: "unbounded", description: "optional budgets" };
for (let i = 0; i < 140; i++) await log("call-" + i);
for (let i = 0; i < 6; i++) await agent("check", { key: "step-" + i, agent: "analyst" });
return true;` });
    const runtime = { agent: "caller", model: { providerID: "test", id: "model" } };
    try {
      const started = await fixture.api.start(fixture.ownerID, input, runtime);
      const run = await settled(fixture.api, fixture.ownerID, started.id);
      expect(run.status).toBe("completed");
      expect(run.steps).toHaveLength(6);
      expect(run.logs).toHaveLength(140);
      expect(run.limits).toEqual({ concurrency: 3, maxAgents: null, agentTimeoutMs: null, timeoutMs: null });
      expect((await fixture.api.start(fixture.ownerID, input, runtime)).id).toBe(run.id);
      expect(fixture.spawns()).toBe(6);
    } finally { await fixture.api.dispose(); }
  });

  test("saved nested unbounded execution remains unbounded after disposal and resume", async () => {
    const fixture = await harness("valid");
    fixture.setSaved("child", `export const meta = { name: "child", description: "unbounded child" };
for (let i = 0; i < 140; i++) await log("child-" + i);
for (let i = 0; i < 6; i++) await agent("check", { key: "step-" + i, agent: "analyst" });
return true;`);
    fixture.setSaved("parent", `export const meta = { name: "parent", description: "saved parent" };
await checkpoint("Continue?", { key: "continue" }); return await workflow("child");`);
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "nested-unbounded", name: "parent" }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const run = await settled(reopened, fixture.ownerID, started.id);
      expect(run.status).toBe("completed");
      expect(run.steps).toHaveLength(6);
      expect(run.limits.maxAgents).toBeNull();
      expect(run.limits.timeoutMs).toBeNull();
      expect(run.limits.agentTimeoutMs).toBeNull();
    } finally { await reopened.dispose(); }
  });

  test("resuming a compacted legacy record enforces its omitted four-step cap", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "legacy-cap", script: `
export const meta = { name: "legacy", description: "legacy cap" };
await checkpoint("Continue?", { key: "continue" });
for (let i = 0; i < 6; i++) await agent("check", { key: "step-" + i, agent: "analyst" });
return true;` }), { agent: "caller", model: { providerID: "test", id: "model" } });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const key = `workflows/runs/${started.id}`;
    const legacy = WorkflowRun.parse(await fixture.getStorage(key));
    await fixture.setStorage(key, { ...legacy, limits: {} });
    const reopened = fixture.reopen();
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const run = await settled(reopened, fixture.ownerID, started.id);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("agent limit reached (4)");
      expect(run.steps).toHaveLength(4);
      expect(run.limits).toEqual({ concurrency: 3, maxAgents: 4, agentTimeoutMs: 1_800_000, timeoutMs: 86_400_000 });
    } finally { await reopened.dispose(); }
  });

  test("unbounded running agents allocate no budget deadline and stop still interrupts them", async () => {
    const fixture = await harness("manual");
    const schedule = spyOn(globalThis, "setTimeout");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "no-timers", script }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      for (let count = 0; count < 200 && fixture.spawns() === 0; count++) await Bun.sleep(5);
      expect(fixture.spawns()).toBe(1);
      await Bun.sleep(20);
      expect(schedule.mock.calls.filter(([, delay]) => delay !== undefined && delay > 1_000)).toEqual([]);
      const stopped = await fixture.api.control(fixture.ownerID, { runID: started.id, action: "stop" });
      expect(stopped.status).toBe("stopped");
      expect(fixture.workerEvents).toContain("interrupt-end");
    } finally { schedule.mockRestore(); await fixture.api.dispose(); }
  });

  test("an explicit whole-run deadline still fails a blocked unbounded-step run", async () => {
    const fixture = await harness("manual");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "run-deadline", script, timeoutMs: 1_000 }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      const run = await settled(fixture.api, fixture.ownerID, started.id);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("timeout");
      expect(run.limits.maxAgents).toBeNull();
      expect(fixture.workerEvents).toContain("interrupt-end");
    } finally { await fixture.api.dispose(); }
  });

  test("expired omitted legacy workflow deadlines still fail on resume", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "legacy-timeout", script: `
export const meta = { name: "legacy", description: "legacy deadline" };
return await checkpoint("Continue?", { key: "continue" });` }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const key = `workflows/runs/${started.id}`;
    const legacy = WorkflowRun.parse(await fixture.getStorage(key));
    await fixture.setStorage(key, { ...legacy, limits: {}, created: Date.now() - 86_400_001 });
    const reopened = fixture.reopen();
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const run = await settled(reopened, fixture.ownerID, started.id);
      expect(run.status).toBe("failed");
      expect(run.error).toBe("Workflow timeout exceeded");
    } finally { await reopened.dispose(); }
  });

  test("preserves explicit checkpoint reviewer through nested workflow replay and rejects reviewer identity changes", async () => {
    const fixture = await harness("valid");
    fixture.setSaved("review", `export const meta = { name: "review", description: "review" }; return await checkpoint("Review", { key: "approval", reviewer: "coordinator" });`);
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "reviewer", script: `export const meta = { name: "reviewer", description: "reviewer" }; return await workflow("review");`, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    expect(waiting.checkpoints[0].reviewer).toBe("coordinator");
    await fixture.api.dispose();
    const storageKey = `workflows/runs/${started.id}`;
    const tampered = WorkflowRun.parse(await fixture.getStorage(storageKey));
    tampered.checkpoints[0].reviewer = "human";
    await fixture.setStorage(storageKey, tampered);
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: waiting.checkpoints[0].key, response: true });
    const failed = await settled(reopened, fixture.ownerID, started.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("reviewer changed on resume");
    expect(failed.checkpoints[0].reviewer).toBe("human");
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

  test("replays checkpoint responses in their original settlement order", async () => {
    const fixture = await harness("valid");
    const ordered = `
export const meta = { name: "checkpoint-order", description: "checkpoint order" };
const seen = [];
await parallel([
  () => checkpoint("A", { key: "a" }).then(() => seen.push("a")),
  () => checkpoint("B", { key: "b" }).then(() => seen.push("b"))
]);
await checkpoint("Park", { key: "park" });
return seen;`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "checkpoint-order", script: ordered, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while ((await fixture.api.get(fixture.ownerID, started.id)).checkpoints.length < 2) await Bun.sleep(2);
    expect((await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "b", response: true })).status).toBe("waiting");
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "a", response: true });
    for (let count = 0; count < 200; count++) {
      if ((await fixture.api.get(fixture.ownerID, started.id)).checkpoints.some((item) => item.key === "park")) break;
      await Bun.sleep(2);
    }
    expect((await fixture.api.get(fixture.ownerID, started.id)).checkpoints.some((item) => item.key === "park")).toBe(true);
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "park", response: true });
    expect((await settled(reopened, fixture.ownerID, started.id)).result).toEqual(["b", "a"]);
    await reopened.dispose();
  });

  test("rejects an oversized checkpoint response without settling it and permits a valid retry", async () => {
    const fixture = await harness("valid");
    const waiting = `
export const meta = { name: "checkpoint-limit", description: "bounded response" };
return await checkpoint("Continue?", { key: "continue" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "checkpoint-limit", script: waiting, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");

    await expect(fixture.api.control(fixture.ownerID, {
      runID: started.id, action: "resume", checkpointKey: "continue", response: "x".repeat(1_048_577),
    })).rejects.toThrow("1 MiB");
    const rejected = await fixture.api.get(fixture.ownerID, started.id);
    expect(rejected.status).toBe("waiting");
    expect(rejected.checkpoints[0].response).toBeUndefined();
    expect(rejected.settlements).toEqual([]);

    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: "yes" });
    expect((await settled(fixture.api, fixture.ownerID, started.id)).result).toBe("yes");
    await fixture.api.dispose();
  });

  test("keeps the deadline reason after interrupt wakes native wait and drains the interrupt", async () => {
    const fixture = await harness("timeout-race");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "timeout-race", script, args: null, agentTimeoutMs: 1_000,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });

    const failed = await settled(fixture.api, fixture.ownerID, started.id);
    expect(failed.error).toContain("timed out after 1000ms");
    expect(fixture.workerEvents).toContain("interrupt-end");
    expect(fixture.workerEvents).not.toContain("send");
    await fixture.api.dispose();
  });

  test("keeps the timeout reason when native wait rejects during interruption", async () => {
    const fixture = await harness("timeout-reject");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "timeout-reject", script, agentTimeoutMs: 1_000,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      const failed = await settled(fixture.api, fixture.ownerID, started.id);
      expect(failed.error).toContain("timed out after 1000ms");
      expect(fixture.workerEvents.filter((event) => event === "interrupt-end")).toHaveLength(
        fixture.workerEvents.filter((event) => event === "interrupt-start").length,
      );
      expect(fixture.workerEvents).not.toContain("send");
    } finally {
      await fixture.api.dispose();
    }
  });

  test("rejects invalid checkpoint input before recovery can write anything", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "checkpoint-preflight", script: `export const meta = { name: "preflight", description: "preflight" }; return await checkpoint("Continue?", { key: "continue" });`,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    await fixture.mutateRun(started.id, (run) => { run.status = "waiting"; });
    const reopened = fixture.reopen();
    try {
      fixture.writes.length = 0;
      await expect(reopened.control(fixture.ownerID, {
        runID: started.id, action: "resume", checkpointKey: "continue", response: "界".repeat(400_000),
      })).rejects.toThrow("1 MiB");
      expect(fixture.writes).toEqual([]);
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      expect((await settled(reopened, fixture.ownerID, started.id)).result).toBe(true);
    } finally {
      await reopened.dispose();
    }
  });

  test("preflights checkpoint journal growth and allows a smaller atomic retry", async () => {
    const fixture = await harness("valid");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "checkpoint-capacity", script: `export const meta = { name: "capacity", description: "capacity" }; return await checkpoint("Continue?", { key: "continue" });`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      const storageKey = `workflows/runs/${started.id}`;
      const raw = JSON.parse(JSON.stringify(await fixture.getStorage(storageKey)));
      raw.args = "";
      raw.args = "x".repeat(16 * 1024 * 1024 - WORKFLOW_CONTROL_HEADROOM - 200 - Buffer.byteLength(JSON.stringify(raw)));
      await fixture.setStorage(storageKey, raw);
      fixture.writes.length = 0;
      await expect(fixture.api.control(fixture.ownerID, {
        runID: started.id, action: "resume", checkpointKey: "continue", response: "x".repeat(1_000),
      })).rejects.toThrow("headroom");
      expect(fixture.writes).toEqual([]);
      expect(await fixture.getStorage(storageKey)).toEqual(raw);
      expect(await fixture.getStorage(`workflows/completions/${started.id}`)).toBeUndefined();
      await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const completed = await settled(fixture.api, fixture.ownerID, started.id);
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe(true);
    } finally {
      await fixture.api.dispose();
    }
  });

  test("checkpoint replies retain an agent settlement committed during control preflight", async () => {
    const fixture = await harness("manual");
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "checkpoint-concurrent", script: `export const meta = { name: "concurrent", description: "concurrent" };
const read = agent("Read", { key: "read", agent: "analyst" });
await agent("Gate", { key: "gate", agent: "analyst" });
const response = await checkpoint("Continue?", { key: "continue" });
return [await read, response];`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      while (!fixture.spawnedStepKeys.includes("read") || !fixture.spawnedStepKeys.includes("gate")) await Bun.sleep(2);
      await fixture.complete("gate");
      await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      const gate = fixture.blockStorageRead(`workflows/completions/${started.id}`);
      const reply = fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      await gate.started;
      try {
        await fixture.complete("read");
        for (let count = 0; count < 100; count++) {
          if ((await fixture.api.get(fixture.ownerID, started.id)).settlements?.some((item) => item.kind === "agent" && item.key === "read")) break;
          await Bun.sleep(2);
        }
        expect((await fixture.api.get(fixture.ownerID, started.id)).settlements).toContainEqual({ kind: "agent", key: "read", outcome: "success" });
      } finally {
        gate.release();
      }
      await reply;
      const completed = await settled(fixture.api, fixture.ownerID, started.id);
      expect(completed.status).toBe("completed");
      expect(completed.settlements).toEqual([
        { kind: "agent", key: "gate", outcome: "success" },
        { kind: "agent", key: "read", outcome: "success" },
        { kind: "checkpoint", key: "continue", response: true },
      ]);
    } finally {
      await fixture.api.dispose();
    }
  });

  test("rejects aggregate settlement overflow without replacing either legacy record", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "settlement-capacity", script: `export const meta = { name: "settlements", description: "settlements" }; return await checkpoint("Continue?", { key: "continue" });`,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const legacy = [{ kind: "agent", key: "", outcome: "success" }];
    legacy[0].key = "x".repeat(16 * 1024 * 1024 - 100 - Buffer.byteLength(JSON.stringify(legacy)));
    await fixture.setStorage(`workflows/completions/${started.id}`, legacy);
    const runKey = `workflows/runs/${started.id}`;
    const reopened = fixture.reopen();
    try {
      await reopened.get(fixture.ownerID, started.id);
      const before = await fixture.getStorage(runKey);
      fixture.writes.length = 0;
      await expect(reopened.control(fixture.ownerID, {
        runID: started.id, action: "resume", checkpointKey: "continue", response: "x".repeat(200),
      })).rejects.toThrow("settlement journal exceeds the 16 MiB");
      expect(fixture.writes).toEqual([]);
      expect(await fixture.getStorage(runKey)).toEqual(before);
      expect(await fixture.getStorage(`workflows/completions/${started.id}`)).toEqual(legacy);
    } finally {
      await reopened.dispose();
    }
  });

  test("a live legacy replay observes an atomic checkpoint reply", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "legacy-live", script: `export const meta = { name: "legacy-live", description: "legacy-live" };
await agent("Read", { key: "read", agent: "analyst" });
return await checkpoint("Continue?", { key: "continue" });`,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    await fixture.mutateRun(started.id, (run) => { delete run.settlements; });
    const legacy = [{ kind: "agent", key: "read", outcome: "success" }];
    await fixture.setStorage(`workflows/completions/${started.id}`, legacy);
    const reopened = fixture.reopen();
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
      await reaches(reopened, fixture.ownerID, started.id, "waiting");
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: "yes" });
      expect((await settled(reopened, fixture.ownerID, started.id)).result).toBe("yes");
      expect(await fixture.getStorage(`workflows/completions/${started.id}`)).toEqual(legacy);
    } finally {
      await reopened.dispose();
    }
  });

  test("replays a previously exposed failure without changing the retry branch", async () => {
    const fixture = await harness("manual");
    const branching = `
export const meta = { name: "failure-order", description: "stable retry branch" };
try { await agent("first", { key: "first", agent: "analyst" }); }
catch (_) { await agent("fallback", { key: "fallback", agent: "analyst" }); }
await checkpoint("Park", { key: "park" });
return "done";`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "failure-order", script: branching, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("first")) await Bun.sleep(2);
    await fixture.complete("first", "failed");
    while (!fixture.spawnedStepKeys.includes("fallback")) await Bun.sleep(2);
    await fixture.complete("fallback");
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "park", response: true });
    const replayed = await settled(reopened, fixture.ownerID, started.id);
    expect(replayed.status).toBe("failed");
    expect(replayed.steps.find((step) => step.key === "first")?.status).toBe("failed");
    expect(fixture.spawnedStepKeys.filter((key) => key === "first")).toHaveLength(1);
    await reopened.dispose();
  });

  test("reconciles a checkpoint settlement recorded before checkpoint state", async () => {
    const fixture = await harness("valid");
    const waiting = `
export const meta = { name: "checkpoint-crash", description: "two-write recovery" };
return await checkpoint("Continue?", { key: "continue" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "checkpoint-crash", script: waiting, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    await fixture.setStorage(`workflows/completions/${started.id}`, [
      { kind: "checkpoint", key: "continue", response: "yes" },
    ]);
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    const completed = await settled(reopened, fixture.ownerID, started.id);
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("yes");
    expect(completed.checkpoints[0].response).toBe("yes");
    await reopened.dispose();
  });

  test("persists a terminal diagnostic for an unreplayable legacy journal", async () => {
    const fixture = await harness("valid");
    const legacy = `
export const meta = { name: "legacy", description: "fail closed" };
await agent("inspect", { key: "inspect", agent: "analyst" });
return await checkpoint("Continue?", { key: "continue" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "legacy", script: legacy, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    await fixture.setStorage(`workflows/completions/${started.id}`, ["inspect"]);
    await fixture.mutateRun(started.id, (run) => {
      run.status = "interrupted";
      run.checkpoints[0].response = true;
      delete run.settlements;
    });
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    const failed = await settled(reopened, fixture.ownerID, started.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Legacy completion journal");
    let delivered = failed;
    for (let count = 0; count < 100 && !delivered.delivered; count++) {
      await Bun.sleep(2);
      delivered = await reopened.get(fixture.ownerID, started.id);
    }
    expect(delivered.delivered).toBe(true);
    await reopened.dispose();
  });

  test("allows the same worker to resolve a crash after its report was recorded", async () => {
    const fixture = await harness("manual");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "reported-crash", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("inspect")) await Bun.sleep(2);
    await fixture.report("inspect", "failed");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    const interrupted = await reaches(reopened, fixture.ownerID, started.id, "interrupted");
    expect(interrupted.error).toContain("same worker");
    expect(interrupted.interruption).toBeUndefined();
    fixture.setOutcome("inspect", "succeeded");
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    expect((await settled(reopened, fixture.ownerID, started.id)).status).toBe("completed");
    await reopened.dispose();
  });

  test("checks token budget when queued work receives a dispatch permit", async () => {
    const fixture = await harness("manual");
    const parallel = `
export const meta = { name: "queued-budget", description: "dispatch budget" };
return await parallel([
  () => agent("a", { key: "a", agent: "analyst" }),
  () => agent("b", { key: "b", agent: "analyst" })
]);`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "queued-budget", script: parallel, args: null, concurrency: 1, tokenBudget: 1 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (fixture.spawnedStepKeys.length < 1) await Bun.sleep(2);
    await fixture.complete(fixture.spawnedStepKeys[0]);
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(fixture.spawnedStepKeys).toHaveLength(1);
    expect(run.error).toContain("token budget reached");
    await fixture.api.dispose();
  });

  test("charges measured failed attempts against the token budget", async () => {
    const fixture = await harness("reported-fail");
    const budgeted = `
export const meta = { name: "failed-budget", description: "failed usage" };
try { await agent("first", { key: "first", agent: "analyst" }); } catch (_) {}
return await agent("second", { key: "second", agent: "analyst" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "failed-budget", script: budgeted, args: null, tokenBudget: 1 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("failed");
    expect(fixture.spawnedStepKeys).toEqual(["first"]);
    expect(run.steps[0].status === "failed" && run.steps[0].usage).toEqual({ tokens: 18, cost: 0.02, measured: true });
    expect(run.steps[1].status).toBe("prepared");
    await fixture.api.dispose();
  });

  test("replays a denied prepared step with its original budget error", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "budget-replay", tokenBudget: 1,
      script: `export const meta = { name: "budget-replay", description: "budget-replay" };
await agent("First", { key: "first", agent: "analyst" });
try { await agent("Second", { key: "second", agent: "analyst" }); }
catch (error) { await log(error.message); }
await checkpoint("Continue?", { key: "continue" });`,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });
    const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    expect(waiting.steps[1].status).toBe("prepared");
    expect(waiting.logs[0].text).toContain("token budget reached");
    await fixture.api.dispose();
    const reopened = fixture.reopen();
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const replayed = await settled(reopened, fixture.ownerID, started.id);
      expect(replayed.logs.map((item) => item.text)).toEqual([waiting.logs[0].text, waiting.logs[0].text]);
      expect(fixture.spawnedStepKeys).toEqual(["first"]);
    } finally {
      await reopened.dispose();
    }
  });

  test("bounds eight simultaneous failure diagnostics in serialized bytes at capacity", async () => {
    const fixture = await harness("large-error", 8);
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "failure-capacity", concurrency: 8, maxAgents: 8,
        script: `export const meta = { name: "failure-capacity", description: "failure-capacity" };
return await parallel(Array.from({ length: 8 }, (_, index) => () => agent("Read", { key: "read-" + index, agent: "analyst" })));`,
      }), { agent: "caller", model: { providerID: "test", id: "model" } });
      for (let count = 0; count < 200; count++) {
        const run = await fixture.api.get(fixture.ownerID, started.id);
        if (run.steps.length === 8 && run.steps.every((step) => !step.profileFingerprint.startsWith("pending:"))) break;
        await Bun.sleep(2);
      }
      expect(fixture.spawnedStepKeys).toHaveLength(8);
      const storageKey = `workflows/runs/${started.id}`;
      const raw = JSON.parse(JSON.stringify(await fixture.getStorage(storageKey)));
      raw.args = "";
      raw.args = "x".repeat(16 * 1024 * 1024 - WORKFLOW_CONTROL_HEADROOM - Buffer.byteLength(JSON.stringify(raw)));
      await fixture.setStorage(storageKey, raw);
      fixture.failWorkers("界\u0000".repeat(20_000));
      const failed = await settled(fixture.api, fixture.ownerID, started.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("界");
      expect(Buffer.byteLength(JSON.stringify(failed.error)) - 2).toBeLessThanOrEqual(WORKFLOW_DIAGNOSTIC_JSON_BYTES);
      for (const step of failed.steps) {
        expect(step.status).toBe("failed");
        if (step.status === "failed") expect(Buffer.byteLength(JSON.stringify(step.error)) - 2).toBeLessThanOrEqual(WORKFLOW_DIAGNOSTIC_JSON_BYTES);
      }
      expect(Buffer.byteLength(JSON.stringify(await fixture.getStorage(storageKey)))).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(failed.args).toBe(raw.args);
    } finally {
      await fixture.api.dispose();
    }
  });

  test("isolates corrupt and full legacy siblings with owner-visible recovery diagnostics", async () => {
    const fixture = await harness("valid");
    const input = WorkflowStart.parse({
      key: "healthy", script: `export const meta = { name: "healthy", description: "healthy" }; return true;`,
    });
    const started = await fixture.api.start(fixture.ownerID, input, { agent: "caller", model: { providerID: "test", id: "model" } });
    await settled(fixture.api, fixture.ownerID, started.id);
    await fixture.api.dispose();
    const raw = JSON.parse(JSON.stringify(await fixture.getStorage(`workflows/runs/${started.id}`)));
    const corrupt = { ...raw, id: "corrupt", version: 99, evidence: "preserve raw" };
    const full = { ...raw, id: "legacy-full", status: "running", delivered: false, args: "" };
    delete full.settlements;
    full.args = "x".repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(full)));
    await fixture.setStorage("workflows/runs/corrupt", corrupt);
    await fixture.setStorage("workflows/runs/legacy-full", full);
    const reopened = fixture.reopen();
    try {
      expect((await reopened.get(fixture.ownerID, started.id)).status).toBe("completed");
      const listed = await reopened.list(fixture.ownerID);
      expect(listed.some((run) => run.id === started.id)).toBe(true);
      await expect(reopened.get(fixture.ownerID, "corrupt")).rejects.toThrow("raw data was preserved");
      expect(fixture.deliveryTexts.some((text) => text.includes("corrupt") && text.includes("workflows/runs/corrupt"))).toBe(true);
      expect(fixture.deliveryTexts.some((text) => text.includes("legacy-full") && text.includes("hard limit"))).toBe(true);
      expect(await fixture.getStorage("workflows/runs/corrupt")).toEqual(corrupt);
      expect(await fixture.getStorage("workflows/runs/legacy-full")).toEqual(full);
      const next = await reopened.start(fixture.ownerID, { ...input, key: "healthy-next" }, { agent: "caller", model: { providerID: "test", id: "model" } });
      expect((await settled(reopened, fixture.ownerID, next.id)).status).toBe("completed");
    } finally {
      await reopened.dispose();
    }
  });

  test("clears the initialization deadline and notifies the owner when a full legacy record cannot persist failure", async () => {
    const fixture = await harness("valid");
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
      key: "initialization-capacity",
      script: `export const meta = { name: "initialization", description: "initialization" }; return await checkpoint("Continue?", { key: "continue" });`,
    }), { agent: "caller", model: { providerID: "test", id: "model" } });
    await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
    await fixture.api.dispose();
    const runKey = `workflows/runs/${started.id}`;
    const legacyKey = `workflows/completions/${started.id}`;
    const full = JSON.parse(JSON.stringify(await fixture.getStorage(runKey)));
    delete full.settlements;
    delete full.interruption;
    delete full.error;
    full.limits.timeoutMs = 604_800_000;
    full.args = "";
    full.args = "x".repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(full)));
    await fixture.setStorage(runKey, full);
    const corruptJournal = { corrupt: "retained initialization evidence" };
    await fixture.setStorage(legacyKey, corruptJournal);
    const reopened = fixture.reopen();
    const schedule = spyOn(globalThis, "setTimeout");
    const cancel = spyOn(globalThis, "clearTimeout");
    const gate = fixture.blockStorageRead(legacyKey);
    try {
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
      await gate.started;
      const before = await fixture.getStorage(runKey);
      fixture.writes.length = 0;
      gate.release();
      await Bun.sleep(0);
      const deadlineIndex = schedule.mock.calls.findIndex(([, delay]) => delay !== undefined && delay > 604_000_000);
      expect(deadlineIndex).toBeGreaterThanOrEqual(0);
      const deadline = schedule.mock.results[deadlineIndex].value;
      const notification = fixture.deliveryTexts.find((text) => text.includes(`workflows/runs/${started.id}`));
      expect({
        cleared: cancel.mock.calls.some(([timer]) => timer === deadline),
        notified: notification !== undefined,
      }).toEqual({ cleared: true, notified: true });
      expect(notification).toContain("settlement journal must be an array");
      expect(notification).toContain("hard limit");
      expect(fixture.writes).toEqual([]);
      expect(await fixture.getStorage(runKey)).toEqual(before);
      expect(await fixture.getStorage(legacyKey)).toEqual(corruptJournal);
    } finally {
      gate.release();
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        const result = schedule.mock.results[index];
        if (delay !== undefined && delay > 604_000_000 && result.type === "return") clearTimeout(result.value);
      }
      schedule.mockRestore();
      cancel.mockRestore();
      await reopened.dispose();
    }
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

  test("admits a step directory inside a granted path and forwards the resolved grant", async () => {
    const fixture = await harness("valid");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "workflow-grant-")));
    const aliases = await mkdtemp(join(tmpdir(), "workflow-grant-alias-"));
    temporary.push(outside, aliases);
    await mkdir(join(outside, "sub"));
    await symlink(outside, join(aliases, "link"));
    const granted = `
export const meta = { name: "granted", description: "granted directory" };
return await agent("inspect", { key: "granted", agent: "analyst", directory: ${JSON.stringify(join(outside, "sub"))}, paths: [${JSON.stringify(join(aliases, "link"))}] });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "granted", script: granted, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(run.steps[0].input.paths).toEqual([outside]);
    expect(run.steps[0].directory).toBe(join(outside, "sub"));
    expect(fixture.spawnInputs.map(({ directory, paths }) => ({ directory, paths }))).toEqual([{ directory: join(outside, "sub"), paths: [outside] }]);
    await fixture.api.dispose();
  });

  test("rejects invalid grants before admission", async () => {
    const fixture = await harness("valid");
    for (const [key, paths, message] of [
      ["missing", [join(fixture.directory, "missing")], "existing directory"],
      ["relative", ["relative"], "must be absolute"],
      ["root", ["/"], "filesystem root"],
    ] as const) {
      const invalid = `
export const meta = { name: "invalid-grant", description: "grant validation" };
return await agent("inspect", { key: "grant", agent: "analyst", paths: ${JSON.stringify(paths)} });`;
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: `invalid-${key}`, script: invalid, args: null }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      const run = await settled(fixture.api, fixture.ownerID, started.id);
      expect(run.status).toBe("failed");
      expect(run.error).toContain(message);
      expect(run.steps).toHaveLength(0);
    }
    expect(fixture.spawns()).toBe(0);
    await fixture.api.dispose();
  });

  test("rejects a granted step directory whose project escapes its grants or an explicit deny, before admission", async () => {
    const fixture = await harness("valid");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "workflow-grant-")));
    temporary.push(outside);
    const repo = join(outside, "repo");
    for (const path of [join(outside, "private"), join(repo, "project"), join(repo, ".git", "objects"), join(repo, ".git", "refs")]) {
      await mkdir(path, { recursive: true });
    }
    await Bun.write(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const attempt = async (key: string, options: Record<string, unknown>) => {
      const script = `
export const meta = { name: "${key}", description: "granted project" };
return await agent("inspect", ${JSON.stringify({ key, agent: "analyst", ...options })});`;
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key, script, args: null }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      return settled(fixture.api, fixture.ownerID, started.id);
    };
    const rejected = async (key: string, options: Record<string, unknown>, message: string) => {
      const run = await attempt(key, options);
      expect(run.status).toBe("failed");
      expect(run.error).toContain(message);
      expect(run.steps).toHaveLength(0);
    };
    const readProfile = { action: "read", resource: "*", effect: "allow" };
    fixture.setOwnerPermissions([{ action: "external_directory", resource: `${outside}/private/*`, effect: "deny" }]);
    await rejected("coordinator-directory", { directory: join(outside, "private"), paths: [outside] }, `explicit external_directory deny (${outside}/private/*)`);
    await rejected("coordinator-root", { directory: outside, paths: [outside] }, `would make ${outside} local to its worker`);
    fixture.setOwnerPermissions([]);
    fixture.setProfilePermissions([readProfile, { action: "external_directory", resource: "*/private/*", effect: "deny" }]);
    await rejected("role-repository", { directory: join(repo, "project"), paths: [repo] },
      `would make ${repo} local to its worker, where the explicit external_directory deny (*/private/*) cannot apply`);
    fixture.setProfilePermissions([readProfile]);
    await rejected("widened", { directory: join(repo, "project"), paths: [join(repo, "project")] }, `is in project ${repo}, which extends beyond its granted paths`);
    fixture.setOwnerPermissions([{ action: "external_directory", resource: `${dirname(outside)}/.opencode-workflows/*`, effect: "deny" }]);
    await rejected("checkout", { directory: outside, paths: [outside], access: "write", isolation: "worktree" },
      `would make ${dirname(outside)}/.opencode-workflows/workflow-`);
    expect(fixture.spawns()).toBe(0);
    expect(fixture.reservations).toEqual([]);
    fixture.setOwnerPermissions([{ action: "external_directory", resource: `${outside}/private/*`, effect: "deny" }]);
    const allowed = await attempt("repository", { directory: join(repo, "project"), paths: [repo] });
    expect(allowed.status).toBe("completed");
    expect(allowed.steps[0].directory).toBe(join(repo, "project"));
    expect(fixture.spawns()).toBe(1);
    await fixture.api.dispose();
  });

  test("tells each worker spawn whether only a grant admits its step and whether it runs in a worktree checkout", async () => {
    const fixture = await harness("valid");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "workflow-grant-")));
    temporary.push(outside);
    const steps = `
export const meta = { name: "scopes", description: "destination checks" };
await agent("owned", { key: "owned", agent: "analyst", access: "write", isolation: "worktree" });
await agent("granted", { key: "granted", agent: "analyst", directory: ${JSON.stringify(outside)}, paths: [${JSON.stringify(outside)}] });
return await agent("checkout", { key: "checkout", agent: "analyst", access: "write", isolation: "worktree", directory: ${JSON.stringify(outside)}, paths: [${JSON.stringify(outside)}] });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "scopes", script: steps, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(fixture.spawnScopes).toEqual([
      { granted: false, isolation: "worktree" },
      { granted: true, isolation: "shared" },
      { granted: true, isolation: "worktree" },
    ]);
    expect(fixture.spawnInputs.map(({ directory }) => directory)).toEqual([
      run.steps[0].directory, outside, join(dirname(outside), ".opencode-workflows", run.steps[2].directory.split("/").at(-1)!),
    ]);
    await fixture.api.dispose();
  });

  for (const retarget of [false, true]) {
    test(retarget ? "fails a replayed step whose granted path now resolves elsewhere" : "replays an unchanged grant without dispatching again", async () => {
      const fixture = await harness("valid");
      const scratch = await realpath(await mkdtemp(join(tmpdir(), "workflow-grant-")));
      temporary.push(scratch);
      const [first, second, link] = ["first", "second", "link"].map((name) => join(scratch, name));
      await mkdir(first);
      await mkdir(second);
      await symlink(first, link);
      const linked = `
export const meta = { name: "linked", description: "grant replay" };
const value = await agent("inspect", { key: "linked", agent: "analyst", paths: [${JSON.stringify(link)}] });
await checkpoint("Continue?", { key: "continue" });
return value;`;
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "linked", script: linked, args: null }), {
        agent: "caller", model: { providerID: "test", id: "model" },
      });
      const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      expect(waiting.steps[0].input.paths).toEqual([first]);
      await fixture.api.dispose();
      if (retarget) {
        await rm(link);
        await symlink(second, link);
      }
      const reopened = fixture.reopen();
      await reopened.control(fixture.ownerID, { runID: started.id, action: "resume", checkpointKey: "continue", response: true });
      const run = await settled(reopened, fixture.ownerID, started.id);
      expect(run.status).toBe(retarget ? "failed" : "completed");
      if (retarget) expect(run.error).toContain("resumed with different input");
      else expect(run.result).toEqual({ ok: true });
      expect(fixture.spawns()).toBe(1);
      await reopened.dispose();
    });
  }

  test("allocates a nested source project's worktree under its own project ID", async () => {
    const fixture = await harness("valid");
    const source = join(fixture.directory, "nested-repository");
    await mkdir(source);
    const script = `
export const meta = { name: "nested", description: "source project" };
return await agent("check", { key: "nested", agent: "analyst", access: "write", isolation: "worktree", directory: ${JSON.stringify(source)} });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "nested-source", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    const run = await settled(fixture.api, fixture.ownerID, started.id);
    expect(run.status).toBe("completed");
    expect(fixture.worktreeProjects).toEqual(["source-project"]);
    expect(run.steps[0].directory).toContain(".opencode-workflows/workflow-");
    await fixture.api.dispose();
  });

  test("queued worktree steps wait for a worker permit before reserving sessions", async () => {
    const fixture = await harness("manual", 2);
    const script = `
export const meta = { name: "queued-worktrees", description: "capacity" };
return await parallel(["one", "two", "three"].map(key => () => agent(key, {
  key, agent: "analyst", access: "write", isolation: "worktree"
})));`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "queued-worktrees", script, args: null, concurrency: 1, maxAgents: 3 }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (fixture.spawns() < 1) await Bun.sleep(2);
    expect(fixture.reservations).toHaveLength(1);
    for (let index = 0; index < 3; index++) {
      while (fixture.spawns() < index + 1) await Bun.sleep(2);
      await fixture.complete(fixture.spawnedStepKeys[index]);
    }
    expect((await settled(fixture.api, fixture.ownerID, started.id)).status).toBe("completed");
    expect(fixture.reservations).toHaveLength(3);
    await fixture.api.dispose();
  });

  test("pause during worktree allocation does not prompt a worker until resume", async () => {
    const fixture = await harness("manual");
    const gate = fixture.blockWorktreeCreation();
    const script = `
export const meta = { name: "pause-allocation", description: "dispatch gate" };
return await agent("write", { key: "write", agent: "analyst", access: "write", isolation: "worktree" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "pause-allocation", script, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    await gate.started;
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "pause" });
    await reaches(fixture.api, fixture.ownerID, started.id, "paused");
    gate.release();
    await Bun.sleep(20);
    expect(fixture.spawns()).toBe(0);
    expect((await fixture.api.get(fixture.ownerID, started.id)).status).toBe("paused");
    await fixture.api.control(fixture.ownerID, { runID: started.id, action: "resume" });
    while (fixture.spawns() < 1) await Bun.sleep(2);
    await fixture.complete("write");
    expect((await settled(fixture.api, fixture.ownerID, started.id)).status).toBe("completed");
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
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].status === "completed" && run.steps[0].usage.measured).toBe(false);
    expect(run.steps[1].status).toBe("prepared");
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

  test("does not reserve a replacement for a missing dispatched worktree worker with a pending profile", async () => {
    const fixture = await harness("manual");
    const write = `
export const meta = { name: "missing-worktree", description: "ambiguous dispatch" };
return await agent("write", { key: "write", agent: "analyst", access: "write", isolation: "worktree" });`;
    const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "missing-worktree", script: write, args: null }), {
      agent: "caller", model: { providerID: "test", id: "model" },
    });
    while (!fixture.spawnedStepKeys.includes("write")) await Bun.sleep(2);
    await fixture.api.dispose();
    await fixture.mutateRun(started.id, (run) => {
      run.steps[0].profileFingerprint = `pending:${run.steps[0].profileFingerprint}`;
    });
    fixture.deleteWorker("write");
    const reopened = fixture.reopen();
    await reopened.control(fixture.ownerID, { runID: started.id, action: "resume" });
    const run = await reaches(reopened, fixture.ownerID, started.id, "interrupted");
    expect(run.error).toContain("external state is ambiguous");
    expect(fixture.reservations).toHaveLength(1);
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
    fixture.setRestartNotice(workerID);
    await fixture.mutateRun(started.id, (run) => { run.status = "running"; delete run.interruption; });
    const reopened = fixture.reopen();
    await expect(reopened.prepareContext(workerID)).rejects.toThrow("explicitly resumed");
    expect(fixture.deliveryTexts.some((text) => text.includes(started.id) && text.includes("read") && text.includes(workerID) && text.includes("running") && text.includes("tools.workflows.control"))).toBe(true);
    authorizeWorkflowExecution(workerID);
    await expect(reopened.prepareContext(workerID)).resolves.toBeUndefined();
    expect((await reopened.get(fixture.ownerID, started.id)).status).toBe("interrupted");
    expect((await reopened.get(fixture.ownerID, started.id)).interruption?.kind).toBe("lease-lost");
    expect(fixture.spawns()).toBe(1);
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
    try {
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
      await fixture.waitForSpawn("c");
      expect(fixture.spawnedStepKeys).toContain("c");
      await fixture.complete("c");
      expect((await settled(fixture.api, fixture.ownerID, second.id)).status).toBe("completed");
      await fixture.api.control(fixture.ownerID, { runID: first.id, action: "stop" });
    } finally {
      await fixture.api.dispose();
    }
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

const runtime = { agent: "caller", model: { providerID: "test", id: "model" } };
const worktreeScript = (keys: string[], tail = `return "done";`) => `
export const meta = { name: "cleanup", description: "worktree cleanup" };
const keys = ${JSON.stringify(keys)};
for (let i = 0; i < keys.length; i++) await agent(keys[i], { key: keys[i], agent: "analyst", access: "write", isolation: "worktree" });
${tail}`;

async function until(api: ReturnType<typeof workflowEngine>, ownerID: string, runID: string, done: (run: WorkflowRun) => boolean) {
  let latest: WorkflowRun | undefined;
  for (let count = 0; count < 400; count++) {
    latest = await api.get(ownerID, runID);
    if (done(latest)) return latest;
    await Bun.sleep(5);
  }
  throw new Error(`workflow condition not reached: ${JSON.stringify({ status: latest?.status, delivered: latest?.delivered, worktreeCleanup: latest?.worktreeCleanup })}`);
}

const cleaned = (api: ReturnType<typeof workflowEngine>, ownerID: string, runID: string) =>
  until(api, ownerID, runID, (run) => run.worktreeCleanup?.complete === true);
const outcomes = (run: WorkflowRun) => Object.fromEntries((run.worktreeCleanup?.worktrees ?? []).map(({ key, outcome, reason }) => [key, reason ? `${outcome}:${reason}` : outcome]));
const stepDirectory = (run: WorkflowRun, key: string) => run.steps.find((step) => step.key === key)!.directory;
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("workflow worktree cleanup", () => {
  test("removes a finished run's clean worktrees and records why it kept the others", async () => {
    const fixture = await harness("valid", 2, {});
    try {
      fixture.setCheckoutState((directory) => directory.includes("-dirty-") ? "changes" : directory.includes("-committed-") ? "commits" : "clean");
      fixture.setRemovalRefusal((directory) => directory.includes("-racing-") ? "dirty" : undefined);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "cleanup-mixed",
        script: worktreeScript(["clean", "dirty", "committed", "racing"], `await agent("shared", { key: "shared", agent: "analyst", access: "write" });\nreturn "done";`),
      }), runtime);
      const run = await until(fixture.api, fixture.ownerID, started.id, (latest) => latest.delivered && latest.worktreeCleanup?.complete === true);
      expect(run.status).toBe("completed");
      expect(run.result).toBe("done");
      expect(run.error).toBeUndefined();
      expect(run.delivered).toBe(true);
      expect(run.finished).toBeNumber();
      expect(outcomes(run)).toEqual({ clean: "removed", dirty: "kept:changes", committed: "kept:commits", racing: "kept:changes" });
      expect(fixture.removals).toEqual([
        { projectID: "project", directory: stepDirectory(run, "clean"), force: false },
        { projectID: "project", directory: stepDirectory(run, "racing"), force: false },
      ]);
      expect(await exists(stepDirectory(run, "clean"))).toBe(false);
      for (const key of ["dirty", "committed", "racing"]) {
        expect(await exists(stepDirectory(run, key))).toBe(true);
        expect(fixture.registered.has(stepDirectory(run, key))).toBe(true);
      }
      const source = await realpath(run.directory);
      expect(stepDirectory(run, "shared")).toBe(source);
      expect(fixture.inspections).not.toContain(source);
      expect(await exists(source)).toBe(true);
    } finally { await fixture.api.dispose(); }
  });

  test("keeps worktrees of waiting, interrupted, and paused runs, then cleans them after stop", async () => {
    const fixture = await harness("valid", 2, {});
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "cleanup-resumable",
        script: worktreeScript(["write"], `return await checkpoint("Continue?", { key: "continue", reviewer: "coordinator" });`),
      }), runtime);
      const waiting = await reaches(fixture.api, fixture.ownerID, started.id, "waiting");
      const directory = stepDirectory(waiting, "write");
      const unfinished = (status: WorkflowRun["status"]) => ({ runID: started.id, runStatus: status, key: "write", directory, outcome: "kept" as const, reason: "unfinished" as const, message: expect.any(String) });
      expect((await fixture.api.prune(fixture.ownerID, { apply: true })).worktrees).toEqual([unfinished("waiting")]);
      await fixture.api.dispose();
      reopened = fixture.reopen();
      expect((await reopened.get(fixture.ownerID, started.id)).status).toBe("interrupted");
      expect((await reopened.prune(fixture.ownerID, { apply: true })).worktrees).toEqual([unfinished("interrupted")]);
      await fixture.mutateRun(started.id, (run) => { run.status = "paused"; });
      expect((await reopened.prune(fixture.ownerID, { apply: true })).worktrees).toEqual([unfinished("paused")]);
      const kept = await reopened.get(fixture.ownerID, started.id);
      expect(kept.worktreeCleanup).toBeUndefined();
      expect(kept.finished).toBeUndefined();
      expect(fixture.removals).toEqual([]);
      expect(await exists(directory)).toBe(true);
      await reopened.control(fixture.ownerID, { runID: started.id, action: "stop" });
      const stopped = await cleaned(reopened, fixture.ownerID, started.id);
      expect(stopped.status).toBe("stopped");
      expect(outcomes(stopped)).toEqual({ write: "removed" });
      expect(await exists(directory)).toBe(false);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("cleanup failures neither delay delivery nor change the recorded result", async () => {
    const fixture = await harness("valid", 2, {});
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      fixture.setCheckoutState(async (directory): Promise<CheckoutState> => {
        if (!directory.includes("-blocked-")) return "clean";
        await gate;
        throw new Error("git is unavailable");
      });
      fixture.setRemovalRefusal((directory) => directory.includes("-failing-") ? "fail" : undefined);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "cleanup-failure", script: worktreeScript(["blocked", "failing"], `return { ok: true };`),
      }), runtime);
      const delivered = await until(fixture.api, fixture.ownerID, started.id, (run) => run.delivered);
      expect(delivered.status).toBe("completed");
      expect(delivered.result).toEqual({ ok: true });
      expect(delivered.worktreeCleanup).toBeUndefined();
      expect(fixture.deliveries).toContain(delivered.deliveryID);
      release();
      const run = await cleaned(fixture.api, fixture.ownerID, started.id);
      expect(run.status).toBe("completed");
      expect(run.result).toEqual({ ok: true });
      expect(run.error).toBeUndefined();
      expect(run.worktreeCleanup!.worktrees.map(({ key, outcome, reason, message }) => ({ key, outcome, reason, message }))).toEqual([
        { key: "blocked", outcome: "kept", reason: "error", message: "Could not inspect the checkout: git is unavailable" },
        { key: "failing", outcome: "kept", reason: "error", message: "Could not remove the worktree: worktree removal failed" },
      ]);
      expect(fixture.deliveries.filter((id) => id === run.deliveryID)).toHaveLength(1);
    } finally { await fixture.api.dispose(); }
  });

  test("sweeps a finished run once even when its completion notice can't be delivered", async () => {
    const fixture = await harness("valid", 2, {});
    try {
      fixture.failDeliveries(100);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "undelivered", script: worktreeScript(["write"]) }), runtime);
      const run = await cleaned(fixture.api, fixture.ownerID, started.id);
      expect(run.status).toBe("completed");
      expect(run.delivered).toBeFalsy();
      expect(outcomes(run)).toEqual({ write: "removed" });
      fixture.failDeliveries(0);
      await until(fixture.api, fixture.ownerID, started.id, (latest) => latest.delivered);
      await Bun.sleep(20);
      expect(fixture.inspections).toHaveLength(1);
      expect(fixture.removals).toHaveLength(1);
    } finally { await fixture.api.dispose(); }
  });

  test("a run that ended with cleanup off is not swept when it is delivered after a restart with cleanup on", async () => {
    const layout = { cleanupWorktrees: false };
    const fixture = await harness("valid", 2, layout);
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      fixture.failDeliveries(100);
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "late-delivery", script: worktreeScript(["write"]) }), runtime);
      const ended = await until(fixture.api, fixture.ownerID, started.id, (run) => run.status === "completed");
      await fixture.api.dispose();
      fixture.failDeliveries(0);
      layout.cleanupWorktrees = true;
      reopened = fixture.reopen();
      const delivered = await until(reopened, fixture.ownerID, started.id, (run) => run.delivered);
      await Bun.sleep(20);
      expect(delivered.worktreeCleanup).toBeUndefined();
      expect(fixture.inspections).toEqual([]);
      expect(fixture.removals).toEqual([]);
      expect(await exists(stepDirectory(ended, "write"))).toBe(true);
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("prune is a dry run by default, and apply removes only clean worktrees", async () => {
    const fixture = await harness("valid", 2, { cleanupWorktrees: false });
    try {
      fixture.setCheckoutState((directory) => directory.includes("-dirty-") ? "changes" : "clean");
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "prune-later", script: worktreeScript(["clean", "dirty"]),
      }), runtime);
      const finished = await until(fixture.api, fixture.ownerID, started.id, (run) => run.delivered);
      expect(finished.worktreeCleanup).toBeUndefined();
      expect(fixture.removals).toEqual([]);
      const key = `workflows/runs/${started.id}`;
      const before = structuredClone(await fixture.getStorage(key));
      const writes = fixture.writes.length;
      const dry = await fixture.api.prune(fixture.ownerID, {});
      expect(dry.applied).toBe(false);
      expect(dry.worktrees.map(({ key, outcome, reason }) => ({ key, outcome, reason }))).toEqual([
        { key: "clean", outcome: "would-remove", reason: undefined },
        { key: "dirty", outcome: "kept", reason: "changes" },
      ]);
      expect(dry.counts).toEqual({ removed: 0, wouldRemove: 1, kept: 1 });
      expect(fixture.removals).toEqual([]);
      expect(fixture.writes.length).toBe(writes);
      expect(await fixture.getStorage(key)).toEqual(before);
      for (const step of ["clean", "dirty"]) expect(await exists(stepDirectory(finished, step))).toBe(true);

      const applied = await fixture.api.prune(fixture.ownerID, { apply: true });
      expect(applied.applied).toBe(true);
      expect(applied.counts).toEqual({ removed: 1, wouldRemove: 0, kept: 1 });
      expect(fixture.removals).toEqual([{ projectID: "project", directory: stepDirectory(finished, "clean"), force: false }]);
      expect(await exists(stepDirectory(finished, "clean"))).toBe(false);
      expect(await exists(stepDirectory(finished, "dirty"))).toBe(true);
      const recorded = await fixture.api.get(fixture.ownerID, started.id);
      expect(outcomes(recorded)).toEqual({ clean: "removed", dirty: "kept:changes" });
      expect(recorded.worktreeCleanup!.complete).toBe(true);
      expect(recorded.status).toBe("completed");
      expect(recorded.result).toBe("done");
      expect(recorded.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
      expect(() => fixture.workerID("clean")).not.toThrow();

      const again = await fixture.api.prune(fixture.ownerID, { apply: true });
      expect(again.worktrees.map(({ key, outcome }) => ({ key, outcome }))).toEqual([{ key: "dirty", outcome: "kept" }]);
      expect(fixture.removals).toHaveLength(1);
    } finally { await fixture.api.dispose(); }
  });

  test("prune scope: other projects, worktrees in use by unfinished runs, age, and non-root callers", async () => {
    const fixture = await harness("valid", 2, { cleanupWorktrees: false });
    try {
      const first = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "scope-a", script: worktreeScript(["write"]) }), runtime);
      const finished = await until(fixture.api, fixture.ownerID, first.id, (run) => run.delivered);
      const directory = stepDirectory(finished, "write");
      const second = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "scope-b",
        script: `export const meta = { name: "follow-up", description: "uses a retained worktree" };
await agent("check", { key: "check", agent: "analyst", directory: ${JSON.stringify(directory)} });
return await checkpoint("Continue?", { key: "continue", reviewer: "coordinator" });`,
      }), runtime);
      await reaches(fixture.api, fixture.ownerID, second.id, "waiting");
      const inUse = await fixture.api.prune(fixture.ownerID, { apply: true });
      expect(inUse.worktrees.map(({ runID, outcome, reason }) => ({ runID, outcome, reason }))).toEqual([{ runID: first.id, outcome: "kept", reason: "in-use" }]);
      await fixture.api.control(fixture.ownerID, { runID: second.id, action: "stop" });
      expect((await fixture.api.prune(fixture.ownerID, { olderThanDays: 1 })).worktrees).toEqual([]);
      await fixture.mutateRun(first.id, (run) => { run.finished = Date.now() - 2 * 86_400_000; });
      expect((await fixture.api.prune(fixture.ownerID, { olderThanDays: 1 })).worktrees.map(({ outcome }) => outcome)).toEqual(["would-remove"]);
      await fixture.mutateRun(first.id, (run) => { run.projectID = "elsewhere"; });
      expect((await fixture.api.prune(fixture.ownerID, { apply: true })).worktrees).toEqual([]);
      await fixture.mutateRun(first.id, (run) => { run.projectID = "project"; });
      const worker = fixture.workerID("write");
      await expect(fixture.api.prune(worker, { apply: true })).rejects.toThrow("Only a root session");
      expect(fixture.removals).toEqual([]);
      expect((await fixture.api.prune(fixture.ownerID, { apply: true })).counts).toEqual({ removed: 1, wouldRemove: 0, kept: 0 });
    } finally { await fixture.api.dispose(); }
  });

  test("a workflow cannot record a step in a checkout while cleanup removes it", async () => {
    const fixture = await harness("valid", 2, {});
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      fixture.setCheckoutState(async (): Promise<CheckoutState> => {
        await gate;
        return "clean";
      });
      const first = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "exclusion-a", script: worktreeScript(["write"]) }), runtime);
      while (fixture.inspections.length === 0) await Bun.sleep(2);
      const checkout = fixture.inspections[0];
      const spawned = fixture.spawns();
      const lookups = fixture.agentLocations.length;
      const second = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "exclusion-b",
        script: `export const meta = { name: "late", description: "uses a checkout under removal" };
return await agent("check", { key: "check", agent: "analyst", directory: ${JSON.stringify(checkout)} });`,
      }), runtime);
      // The source profile lookup comes just before the step is recorded.
      while (!fixture.agentLocations.slice(lookups).includes(checkout)) await Bun.sleep(2);
      await Bun.sleep(50);
      expect((await fixture.api.get(fixture.ownerID, second.id)).steps).toEqual([]);
      expect(fixture.spawns()).toBe(spawned);
      release();
      const failed = await until(fixture.api, fixture.ownerID, second.id, (run) => run.status === "failed");
      expect(failed.error).toContain("no longer exists");
      expect(failed.steps).toEqual([]);
      expect(fixture.spawns()).toBe(spawned);
      expect(outcomes(await cleaned(fixture.api, fixture.ownerID, first.id))).toEqual({ write: "removed" });
      expect(await exists(checkout)).toBe(false);
    } finally { await fixture.api.dispose(); }
  });

  test("keeps a finished run's checkout while its worker is still running", async () => {
    const fixture = await harness("valid", 2, { cleanupWorktrees: false });
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "busy-worker", script: worktreeScript(["write"]) }), runtime);
      const finished = await until(fixture.api, fixture.ownerID, started.id, (run) => run.delivered);
      const release = fixture.holdWorker("write");
      const busy = await fixture.api.prune(fixture.ownerID, { apply: true });
      expect(busy.worktrees.map(({ outcome, reason, message }) => ({ outcome, reason, message }))).toEqual([
        { outcome: "kept", reason: "in-use", message: "A worker in this directory is still running." },
      ]);
      expect(fixture.inspections).toEqual([]);
      expect(fixture.removals).toEqual([]);
      release();
      expect((await fixture.api.prune(fixture.ownerID, { apply: true })).counts.removed).toBe(1);
      expect(await exists(stepDirectory(finished, "write"))).toBe(false);
    } finally { await fixture.api.dispose(); }
  });

  test("keeps a checkout while a finished run from another project runs a worker in it", async () => {
    const fixture = await harness("valid", 2, { cleanupWorktrees: false });
    try {
      const first = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "shared-checkout", script: worktreeScript(["write"]) }), runtime);
      const checkout = stepDirectory(await until(fixture.api, fixture.ownerID, first.id, (run) => run.delivered), "write");
      const second = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({
        key: "other-project",
        script: `export const meta = { name: "reader", description: "reads a retained checkout" };
return await agent("check", { key: "check", agent: "analyst", directory: ${JSON.stringify(checkout)} });`,
      }), runtime);
      await until(fixture.api, fixture.ownerID, second.id, (run) => run.delivered);
      await fixture.mutateRun(second.id, (run) => { run.projectID = "elsewhere"; });
      const release = fixture.holdWorker("check");
      const held = await fixture.api.prune(fixture.ownerID, { apply: true });
      expect(held.worktrees.map(({ key, outcome, reason }) => ({ key, outcome, reason }))).toEqual([{ key: "write", outcome: "kept", reason: "in-use" }]);
      expect(fixture.removals).toEqual([]);
      release();
      expect((await fixture.api.prune(fixture.ownerID, { apply: true })).counts.removed).toBe(1);
    } finally { await fixture.api.dispose(); }
  });

  test("disposal stops a cleanup pass promptly, and the next engine leaves the rest to prune", async () => {
    const fixture = await harness("valid", 2, {});
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      let stopped = false;
      fixture.setCheckoutState((_directory, signal) => new Promise<CheckoutState>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { stopped = true; reject(signal.reason); }, { once: true });
      }));
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "dispose-pass", script: worktreeScript(["write"]) }), runtime);
      while (fixture.inspections.length === 0) await Bun.sleep(2);
      const before = Date.now();
      await fixture.api.dispose();
      expect(Date.now() - before).toBeLessThan(1_000);
      expect(stopped).toBe(true);
      const key = `workflows/runs/${started.id}`;
      let record = WorkflowRun.parse(await fixture.getStorage(key));
      for (let count = 0; record.worktreeCleanup === undefined && count < 400; count++) {
        await Bun.sleep(5);
        record = WorkflowRun.parse(await fixture.getStorage(key));
      }
      expect(record.status).toBe("completed");
      expect(outcomes(record)).toEqual({ write: "kept:error" });
      fixture.setCheckoutState(() => "clean");
      reopened = fixture.reopen();
      await reopened.get(fixture.ownerID, started.id);
      await Bun.sleep(20);
      expect(fixture.inspections).toHaveLength(1);
      expect(fixture.removals).toEqual([]);
      expect((await reopened.prune(fixture.ownerID, { apply: true })).counts.removed).toBe(1);
      expect(outcomes(await reopened.get(fixture.ownerID, started.id))).toEqual({ write: "removed" });
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });

  test("disposal stops cleanup before it waits for an active run blocked behind cleanup", async () => {
    const fixture = await harness("valid", 2, {});
    try {
      fixture.setCheckoutState((_directory, signal) => new Promise<CheckoutState>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const finished = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "holding-pass", script: worktreeScript(["write"]) }), runtime);
      while (fixture.inspections.length === 0) await Bun.sleep(2);
      const worker = (await fixture.api.get(fixture.ownerID, finished.id)).steps[0].workerID;
      // Reserving a worker reconciles follow-ups under the same lock that the pass holds.
      let blocked = false;
      fixture.setBeforeReserve(async () => {
        blocked = true;
        await serialized(`followup/${worker}`, async () => {});
      });
      await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "blocked-run", script: worktreeScript(["next"]) }), runtime);
      while (!blocked) await Bun.sleep(2);
      const before = Date.now();
      await fixture.api.dispose();
      expect(Date.now() - before).toBeLessThan(1_000);
      expect(fixture.removals).toEqual([]);
    } finally { await fixture.api.dispose(); }
  });

  test("disposal does not wait long for a pass that ignores the stop", async () => {
    const fixture = await harness("valid", 2, {});
    fixture.setCheckoutState(() => new Promise<CheckoutState>(() => {}));
    await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "stuck-pass", script: worktreeScript(["write"]) }), runtime);
    while (fixture.inspections.length === 0) await Bun.sleep(2);
    const before = Date.now();
    await fixture.api.dispose();
    expect(Date.now() - before).toBeLessThan(3_000);
    expect(fixture.removals).toEqual([]);
  });

  test("runs recorded before cleanup existed still load, and prune keeps their finish time", async () => {
    const layout = { cleanupWorktrees: false };
    const fixture = await harness("valid", 2, layout);
    let reopened: ReturnType<typeof workflowEngine> | undefined;
    try {
      const started = await fixture.api.start(fixture.ownerID, WorkflowStart.parse({ key: "legacy-cleanup", script: worktreeScript(["write"]) }), runtime);
      await until(fixture.api, fixture.ownerID, started.id, (run) => run.delivered);
      await fixture.api.dispose();
      const key = `workflows/runs/${started.id}`;
      const legacy = structuredClone(await fixture.getStorage(key)) as Record<string, unknown>;
      const updated = Date.now() - 3 * 86_400_000;
      delete legacy.finished;
      delete legacy.worktreeCleanup;
      legacy.updated = updated;
      await fixture.setStorage(key, legacy);
      layout.cleanupWorktrees = true;
      reopened = fixture.reopen();
      const loaded = await reopened.get(fixture.ownerID, started.id);
      expect(loaded.status).toBe("completed");
      expect(loaded.finished).toBeUndefined();
      expect(loaded.worktreeCleanup).toBeUndefined();
      await Bun.sleep(20);
      expect(fixture.removals).toEqual([]);
      expect((await reopened.prune(fixture.ownerID, { olderThanDays: 4 })).worktrees).toEqual([]);
      const applied = await reopened.prune(fixture.ownerID, { apply: true, olderThanDays: 2 });
      expect(applied.worktrees.map(({ key, outcome }) => ({ key, outcome }))).toEqual([{ key: "write", outcome: "removed" }]);
      const recorded = await reopened.get(fixture.ownerID, started.id);
      expect(recorded.finished).toBe(updated);
      expect(outcomes(recorded)).toEqual({ write: "removed" });
    } finally { await reopened?.dispose(); await fixture.api.dispose(); }
  });
});
