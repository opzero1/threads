import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import Ajv from "ajv";
import { parseWorkflow, executeWorkflow, type WorkflowHost } from "./workflow-runtime";
import { requireDelegation } from "./permissions";
import {
  serialized,
  type threads,
  WorkflowWorker,
  workerIdentity,
  workerLink,
  workflowExecutionAuthorized,
  watchWorkflowExecution,
} from "./threads";
import { workflowHash, workflowStore } from "./workflow-store";
import {
  Json,
  WORKFLOW_DIAGNOSTIC_JSON_BYTES,
  WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES,
  WorkflowAgentInput,
  WorkflowResult,
  WorkflowRun,
  WorkflowSettlement,
  WorkflowStart,
  type WorkflowStep,
  type WorkflowSettlement as Settlement,
} from "./workflow-types";
import {
  interruptWorkflowWorkers,
  withWorkflowSlot,
  workflowDirectory,
  workflowDirectoryPlan,
  workflowSourceDirectory,
  workflowTask,
} from "./workflow-worker";

type Threads = ReturnType<typeof threads>;
type Runtime = { agent: string; model: { providerID: string; id: string; variant?: string } };
type Control = { runID: string; action: "pause" | "resume" | "stop"; checkpointKey?: string; response?: Json };

const processState = globalThis as typeof globalThis & {
  __opWorkflowLeases?: Map<string, { controller: AbortController; promise: Promise<void>; owner: symbol }>;
  __opWorkflowSignals?: Map<string, Set<() => void>>;
};
const leases = processState.__opWorkflowLeases ??= new Map();
const workflowSignals = processState.__opWorkflowSignals ??= new Map();
const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const runIdentity = (ownerID: string, key: string) => `wfr_${digest(ownerID, key).slice(0, 32)}`;
const deliveryIdentity = (runID: string) => SessionMessage.ID.make(`msg_${digest(runID, "delivery").slice(0, 32)}`);
const resultKey = (workerID: string) => `workflows/results/${workerID}`;
const nestedKey = (runID: string, identity: string) => `workflows/nested/${runID}/${digest(identity)}`;
const completionKey = (runID: string) => `workflows/completions/${runID}`;
const terminal = new Set(["stopped", "failed", "completed"]);
const activeStatus = new Set(["running", "pausing", "stopping", "waiting"]);
const settlementLimit = 16 * 1024 * 1024;
const bounded = (text: string, length = 20_000) => text.length <= length ? text : `${text.slice(0, length)}\n…[truncated]`;
const boundedBytes = (text: string, limit: number) => {
  if (Buffer.byteLength(JSON.stringify(text), "utf8") - 2 <= limit) return text;
  const suffix = "\n…[truncated]";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(`${text.slice(0, middle)}${suffix}`), "utf8") - 2 <= limit) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}${suffix}`;
};
const isCompleted = (step: WorkflowStep): step is Extract<WorkflowStep, { status: "completed" }> => step.status === "completed";
const notify = (runID: string) => {
  const listeners = workflowSignals.get(runID);
  if (!listeners) return;
  workflowSignals.delete(runID);
  for (const listener of listeners) listener();
};
const waitForChange = (runID: string, signal: AbortSignal, timeoutMs = 1_000) => new Promise<void>((resolve, reject) => {
  const listeners = workflowSignals.get(runID) ?? new Set<() => void>();
  workflowSignals.set(runID, listeners);
  let timer: ReturnType<typeof setTimeout>;
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    listeners.delete(done);
    if (listeners.size === 0 && workflowSignals.get(runID) === listeners) workflowSignals.delete(runID);
    resolve();
  };
  const aborted = () => {
    clearTimeout(timer);
    listeners.delete(done);
    if (listeners.size === 0 && workflowSignals.get(runID) === listeners) workflowSignals.delete(runID);
    reject(signal.reason ?? new Error("Workflow cancelled"));
  };
  listeners.add(done);
  timer = setTimeout(done, timeoutMs);
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
});
function boundedJson(value: unknown, label: string) {
  const parsed = Json.parse(value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 1_048_576) {
    throw new Error(`${label} exceeds the 1 MiB durable output limit`);
  }
  return parsed;
}

function errorText(error: unknown) {
  return boundedBytes(error instanceof Error ? error.message : String(error), WORKFLOW_DIAGNOSTIC_JSON_BYTES);
}

const settlementError = (error: unknown) => boundedBytes(errorText(error), WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES);
const assertSettlementLimit = (settlements: Settlement[]) => {
  if (Buffer.byteLength(JSON.stringify(settlements), "utf8") > settlementLimit) {
    throw new Error("Workflow settlement journal exceeds the 16 MiB durable limit");
  }
};

function readSettlements(run: WorkflowRun, stored: unknown): Settlement[] {
  const raw = run.settlements !== undefined && (run.settlements.length > 0 || stored === undefined)
    ? run.settlements
    : stored ?? [];
  if (!Array.isArray(raw)) throw new Error("Workflow settlement journal must be an array");
  const legacy = raw.every((entry) => typeof entry === "string");
  if (legacy && raw.length > 0 && run.checkpoints.some((checkpoint) => checkpoint.response !== undefined)) {
    throw new Error("Legacy completion journal cannot deterministically replay answered checkpoints; start a new workflow run key");
  }
  const settlements: Settlement[] = legacy
    ? raw.map((key: string) => ({ kind: "agent", key, outcome: "success" }))
    : raw.map((entry: unknown) => WorkflowSettlement.parse(entry));
  assertSettlementLimit(settlements);
  return settlements;
}

class UncertainWriteError extends Error {}
class SchedulingDeferred extends Error {}
class AdmissionDenied extends Error {}

function usage(session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>) {
  const tokens = session.tokens;
  const measured = tokens !== undefined && session.cost !== undefined;
  return {
    tokens: measured
      ? tokens.input + tokens.output
      : 0,
    cost: measured ? session.cost : 0,
    measured,
  };
}

export function workflowEngine(
  ctx: Plugin.Context,
  workers: Threads,
  options: { maxWorkers?: number; loadSaved?: (name: string) => Promise<string>; warmWorker?: (workerID: string) => Promise<void> } = {},
) {
  const diagnosed = new Set<string>();
  async function diagnose(issue: { id: string; ownerID: string; message: string }) {
    const message = errorText(issue.message);
    const identity = digest(issue.ownerID, issue.id, message);
    await serialized(`workflow-diagnostic:${identity}`, async () => {
      if (diagnosed.has(identity)) return;
      try {
        await ctx.session.synthetic({
          sessionID: issue.ownerID,
          id: SessionMessage.ID.make(`msg_${identity.slice(0, 32)}`),
          text: `Workflow ${issue.id} requires journal recovery: ${message}\nRaw evidence remains at workflows/runs/${issue.id}. Inspect the retained record and repair it or start a new workflow run key. Other runs remain available.`,
          metadata: { opWorkflowJournalDiagnostic: { runID: issue.id, error: message } },
          delivery: "queue", resume: true,
        });
        diagnosed.add(identity);
      } catch {
        // Diagnostic delivery must not make a damaged sibling block healthy runs.
      }
    });
  }
  const store = workflowStore(ctx.storage, { onDiagnostic: diagnose });
  const maxWorkers = options.maxWorkers ?? 4;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) throw new Error("maxWorkers must be a positive integer");
  const ajv = new Ajv({ allErrors: true, strict: false });
  const recoveredOwners = new Set<string>();
  const engineOwner = Symbol("workflow-engine");
  let disposed = false;

  async function nativeWorker(workerID: string) {
    try {
      return await ctx.session.get({ sessionID: workerID });
    } catch (error) {
      if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Session.NotFoundError" && "sessionID" in error && error.sessionID === workerID) return undefined;
      throw error;
    }
  }

  async function owned(ownerID: string, runID: string) {
    const run = await store.get(runID);
    if (run.ownerID !== ownerID) throw new Error("Only the owning session may access this workflow");
    return run;
  }

  async function deliver(runID: string) {
    return serialized(`workflow-delivery:${runID}`, async () => {
      const run = await store.get(runID);
      if (!terminal.has(run.status) || run.delivered) return run;
      const completed = run.steps.filter(isCompleted);
      const report = {
        runID: run.id,
        status: run.status,
        ...(run.error === undefined ? {} : { error: bounded(run.error, 600) }),
        counts: {
          total: run.steps.length,
          completed: completed.length,
          failed: run.steps.filter((step) => step.status === "failed").length,
        },
        evidence: completed.slice(0, 6).map((step) => ({
          key: step.key,
          verdict: step.report.verdict,
          summary: bounded(step.report.summary, 160),
          evidence: step.report.evidence.slice(0, 2).map((item) => bounded(item, 160)),
        })),
      };
      const compact = bounded(JSON.stringify(report), 7_000);
      await ctx.session.synthetic({
        sessionID: run.ownerID,
        id: SessionMessage.ID.make(run.deliveryID),
        text: `Workflow ${run.name} (${run.id}) finished:\n${compact}\nUse workflows_inspect with runID ${run.id} for the full durable result and step details.`,
        metadata: { opWorkflowDelivery: Json.parse(report), runID: run.id },
        delivery: "queue",
        resume: true,
      });
      return store.update(run.id, (current) => { current.delivered = true; }, "control");
    });
  }

  async function recover(ownerID: string) {
    const runs = await store.list(ownerID);
    if (!recoveredOwners.has(ownerID)) {
      recoveredOwners.add(ownerID);
      for (const run of runs) {
        if (activeStatus.has(run.status) && !leases.has(run.id)) {
          try {
            if (run.status === "stopping") {
              await interruptWorkflowWorkers(workers, ownerID, run);
              await store.update(run.id, (current) => {
                current.status = "stopped";
                current.error = "Workflow stop was recovered after server restart.";
              }, "control");
              continue;
            }
            await store.update(run.id, (current) => {
              current.status = "interrupted";
              current.error = "OpenCode stopped while this workflow was active. Inspect its recorded steps, then resume explicitly.";
            }, "control");
          } catch (error) {
            await diagnose({ id: run.id, ownerID, message: errorText(error) });
          }
        }
      }
    }
    for (const run of await store.list(ownerID)) {
      if (terminal.has(run.status) && !run.delivered) {
        await deliver(run.id).catch((error) => diagnose({ id: run.id, ownerID, message: errorText(error) }));
      }
    }
  }

  async function waitUntilRunnable(runID: string, signal: AbortSignal) {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("Workflow cancelled");
      const run = await store.get(runID);
      if (run.status === "running") return;
      if (run.status === "stopping" || run.status === "stopped") throw new Error("Workflow stopped");
      if (run.status === "pausing" && !run.steps.some((step) => step.status === "running")) {
        await store.update(runID, (current) => { if (current.status === "pausing") current.status = "paused"; }, "control");
      }
      await waitForChange(runID, signal);
    }
  }

  async function resolveWorktree(run: WorkflowRun, input: WorkflowAgentInput, key: string) {
    return serialized(`workflow-worktree:${run.id}:${key}`, () => workflowDirectory(ctx, run, input, key));
  }

  function launch(runID: string, runtime: Runtime, recovering = false) {
    if (disposed || leases.has(runID)) return leases.get(runID)?.promise;
    const controller = new AbortController();
    const task = executeRun(runID, runtime, controller, recovering).finally(() => {
      if (leases.get(runID)?.promise === task) leases.delete(runID);
    });
    leases.set(runID, { controller, promise: task, owner: engineOwner });
    void task.catch(() => {});
    return task;
  }

  async function executeRun(runID: string, runtime: Runtime, controller: AbortController, recovering: boolean) {
    let run = await store.get(runID);
    const remaining = run.created + run.limits.timeoutMs - Date.now();
    if (remaining <= 0) {
      await store.update(runID, (current) => { current.status = "failed"; current.error = "Workflow timeout exceeded"; }, "control");
      await deliver(runID);
      return;
    }
    const timer = setTimeout(() => controller.abort(new Error("Workflow timeout exceeded")), remaining);
    const seen = new Set<string>();
    const pendingAgents = new Set<Promise<unknown>>();
    const maxCalls = run.limits.maxAgents * 8 + 100;
    let hostCalls = 0;
    const countCall = () => {
      hostCalls++;
      if (hostCalls > maxCalls) throw new Error(`Workflow cumulative call limit exceeded (${maxCalls})`);
    };
    let completionOrder: Settlement[];
    try {
      const storedCompletionOrder = await ctx.storage.get(completionKey(runID));
      if (run.settlements === undefined || (run.settlements.length === 0 && storedCompletionOrder !== undefined)) {
        run = await store.update(runID, (current) => { current.settlements = readSettlements(current, storedCompletionOrder); });
      }
      completionOrder = readSettlements(run, undefined);
    } catch (error) {
      try {
        await store.update(runID, (current) => { current.status = "failed"; current.error = errorText(error); }, "control")
          .finally(() => clearTimeout(timer));
      } catch (persistError) {
        await diagnose({
          id: runID, ownerID: run.ownerID,
          message: `${errorText(error)}; recording the workflow failure also failed: ${errorText(persistError)}`,
        });
        return;
      }
      await deliver(runID);
      return;
    }
    let completionCursor = 0;
    const refreshSettlements = async () => {
      const refreshed = readSettlements(await store.get(runID), undefined);
      if (refreshed.length >= completionOrder.length) completionOrder = refreshed;
    };
    const appendSettlement = async (entry: Settlement) => {
      const updated = await store.update(runID, (current) => {
        current.settlements ??= [];
        if (!current.settlements.some((item) => item.kind === entry.kind && item.key === entry.key)) {
          const settlements = [...current.settlements, entry];
          assertSettlementLimit(settlements);
          current.settlements = settlements;
        }
      }, entry.kind === "agent" && entry.outcome === "failure" ? "control" : "payload");
      completionOrder = updated.settlements ?? [];
      notify(runID);
    };
    const recordedSettlement = (kind: Settlement["kind"], key: string) => completionOrder.find((item) => item.kind === kind && item.key === key);
    const consumeSettlement = async (kind: Settlement["kind"], key: string) => {
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const next = completionOrder[completionCursor];
        if (next?.kind === kind && next.key === key) {
          completionCursor++;
          notify(runID);
          return next;
        }
        await waitForChange(runID, controller.signal);
        await refreshSettlements();
      }
    };
    const nestedIndexes = new Map<string, number>();
    let active = 0;
    const hostFor = (prefix: string, depth: number): WorkflowHost => ({
      agent: async (raw) => {
        countCall();
        const input = WorkflowAgentInput.parse(raw);
        if (input.schema !== undefined) ajv.compile(input.schema);
        const key = `${prefix}${input.key}`;
        if (seen.has(key)) throw new Error(`Duplicate workflow agent key in this execution: ${key}`);
        seen.add(key);
        await waitUntilRunnable(runID, controller.signal);
        const requestFingerprint = workflowHash(input);
        const beforeAdmission = await store.get(runID);
        const source = await workflowSourceDirectory(ctx, beforeAdmission, input);
        const directoryInput = { ...input, directory: source };
        const owner = await ctx.session.get({ sessionID: beforeAdmission.ownerID });
        const caller = await ctx.agent.get({ agentID: beforeAdmission.callerAgent, location: owner.location });
        requireDelegation([...caller.data.permissions, ...(owner.permissions ?? [])], input.agent);
        const sourceWorker = beforeAdmission.steps.find((step) => step.directory === source);
        if (sourceWorker && options.warmWorker) {
          const existing = await nativeWorker(sourceWorker.workerID);
          if (existing) await options.warmWorker(existing.id);
        }
        const sourceProfile = await ctx.agent.get({ agentID: input.agent, location: { directory: source } });
        const sourceModel = sourceProfile.data.model ?? beforeAdmission.model;
        const sourceProfileFingerprint = workflowHash({
          model: sourceModel,
          permissions: sourceProfile.data.permissions,
          system: sourceProfile.data.system ?? null,
        });
        run = await store.update(runID, (current) => {
          const existing = current.steps.find((step) => step.key === key);
          if (existing) {
            if (existing.fingerprint !== requestFingerprint) throw new Error(`Workflow key ${key} was resumed with different input; use a new run key`);
            return;
          }
          if (current.steps.length >= current.limits.maxAgents) throw new Error(`Workflow agent limit reached (${current.limits.maxAgents})`);
          const plan = workflowDirectoryPlan(current, directoryInput, key);
          const spawnKey = `workflow:${current.id}:${key}`;
          current.steps.push({
            status: "prepared",
            key,
            fingerprint: requestFingerprint,
            index: current.steps.reduce((maximum, step) => Math.max(maximum, step.index), -1) + 1,
            input,
            workerID: workerIdentity(current.ownerID, spawnKey),
            spawnKey,
            created: Date.now(),
            phase: input.phase ?? current.phase,
            directory: plan.directory,
            model: sourceModel,
            profileFingerprint: `pending:${sourceProfileFingerprint}`,
          });
        });
        let previous = run.steps.find((step) => step.key === key)!;
        if (previous.profileFingerprint.startsWith("pending:") && previous.profileFingerprint !== `pending:${sourceProfileFingerprint}`) {
          throw new Error(`Source agent profile for workflow key ${key} changed before worktree allocation; start a new workflow run key`);
        }
        const spawnKey = previous.spawnKey;
        const priorSettlement = recordedSettlement("agent", key);
        if (priorSettlement?.kind === "agent" && priorSettlement.outcome === "failure") {
          let expectedFingerprint = `pending:${sourceProfileFingerprint}`;
          if (!previous.profileFingerprint.startsWith("pending:")) {
            const replayProfile = await ctx.agent.get({ agentID: input.agent, location: { directory: previous.directory } });
            const replayModel = replayProfile.data.model ?? run.model;
            expectedFingerprint = workflowHash({ model: replayModel, permissions: replayProfile.data.permissions, system: replayProfile.data.system ?? null });
          }
          if (previous.profileFingerprint !== expectedFingerprint) {
            throw new Error(`Agent profile for workflow key ${key} changed; start a new workflow run key`);
          }
          const settlement = await consumeSettlement("agent", key);
          throw new Error(settlement.kind === "agent" ? settlement.error ?? `Workflow step ${key} previously failed` : `Workflow step ${key} previously failed`);
        }
        const directory = previous.profileFingerprint.startsWith("pending:")
          ? await resolveWorktree(run, directoryInput, key)
          : previous.directory;
        const dispatch = async () => {
          let admitted = await store.get(run.id);
          if (admitted.status !== "running") throw new SchedulingDeferred();
          if (admitted.limits.tokenBudget !== undefined && admitted.steps.find((step) => step.key === key)?.status === "prepared") {
            const tokenBudget = admitted.limits.tokenBudget;
            const discovered = new Map<string, ReturnType<typeof usage>>();
            for (const step of admitted.steps) {
              if (step.key === key || step.status === "prepared") continue;
              if ("usage" in step && step.usage !== undefined) continue;
              if (step.status === "failed") throw new AdmissionDenied("Workflow token budget cannot continue because prior worker usage is unmeasured");
              if (step.status === "running") {
                const native = await nativeWorker(step.workerID);
                if (native?.outcome !== undefined) discovered.set(step.key, usage(native));
              }
            }
            if (discovered.size > 0) {
              admitted = await store.update(run.id, (value) => {
                for (const step of value.steps) {
                  const measured = discovered.get(step.key);
                  if (measured && step.status === "running") step.usage = measured;
                }
              });
            }
            const spent = admitted.steps.flatMap((step) => step.key !== key && "usage" in step && step.usage !== undefined ? [step.usage] : []);
            if (spent.some((item) => !item.measured)) {
              throw new AdmissionDenied("Workflow token budget cannot continue because prior worker usage is unmeasured");
            }
            const consumed = spent.reduce((sum, item) => sum + item.tokens, 0);
            if (consumed >= tokenBudget) {
              throw new AdmissionDenied(`Workflow token budget reached (${tokenBudget}); in-flight usage may overshoot the soft budget`);
            }
          }
          let current = admitted.steps.find((step) => step.key === key)!;
          const ensureWorker = () => workers.spawnWorkflow(run.ownerID, {
            key: spawnKey,
            title: input.label ?? `Workflow: ${key}`,
            directory,
            task: workflowTask(input),
            agent: input.agent,
          }, runtime as Parameters<Threads["spawnWorkflow"]>[2], {
            ownerID: Session.ID.make(run.ownerID), runID: run.id, stepKey: key,
            callerAgent: run.callerAgent, access: input.access,
          });
          const finalizeProfile = async () => {
            if (options.warmWorker && await nativeWorker(current.workerID)) await options.warmWorker(current.workerID);
            const profile = await ctx.agent.get({ agentID: input.agent, location: { directory } });
            const model = profile.data.model ?? run.model;
            const profileFingerprint = workflowHash({ model, permissions: profile.data.permissions, system: profile.data.system ?? null });
            run = await store.update(run.id, (value) => {
              const step = value.steps.find((item) => item.key === key)!;
              if (!step.profileFingerprint.startsWith("pending:") && step.profileFingerprint !== profileFingerprint) {
                throw new Error(`Agent profile for workflow key ${key} changed; start a new workflow run key`);
              }
              step.directory = directory;
              step.model = model;
              step.profileFingerprint = profileFingerprint;
            });
            return run.steps.find((step) => step.key === key)!;
          };
          if (current.status === "completed") {
            const result = current.report.result;
            await finalizeProfile();
            return result;
          }
          const fresh = current.status === "prepared";
          if (fresh) {
            run = await store.update(run.id, (value) => {
              const index = value.steps.findIndex((step) => step.key === key);
              if (value.steps[index].status === "prepared") {
                value.steps[index] = { ...value.steps[index], status: "running" } as WorkflowStep;
              }
            }, "control");
            current = run.steps.find((step) => step.key === key)!;
          } else {
            try {
              await ctx.session.get({ sessionID: current.workerID });
            } catch (error) {
              const missing = typeof error === "object" && error !== null &&
                "_tag" in error && error._tag === "Session.NotFoundError" &&
                "sessionID" in error && error.sessionID === current.workerID;
              if (!missing) throw error;
              const message = input.access === "write"
                ? "Previously dispatched write worker is missing. Its external state is ambiguous, so it will not be recreated or replayed."
                : "Previously dispatched worker is missing and cannot be safely recreated under the same durable identity.";
              await store.update(run.id, (value) => {
                if (input.access === "write") {
                  value.status = "interrupted";
                  value.error = message;
                  return;
                }
                const index = value.steps.findIndex((step) => step.key === key);
                value.steps[index] = { ...value.steps[index], status: "failed", error: message, retryable: false } as WorkflowStep;
              }, "control");
              throw new Error(message);
            }
          }
          await ensureWorker();
          current = await finalizeProfile();
          const finishRecorded = async (recorded: unknown) => {
            const report = WorkflowResult.parse(recorded);
            const native = await ctx.session.get({ sessionID: current.workerID });
            if (native.outcome !== "succeeded") {
              const message = `Worker reported ${report.verdict} but its native execution ended ${native.outcome ?? "without a successful outcome"}`;
              if (recovering) {
                const resolution = "A durable report exists, but the native execution was interrupted. Ask the same worker to inspect and explicitly resolve the crash window, then resume this workflow.";
                await store.update(run.id, (value) => { value.status = "interrupted"; value.error = resolution; }, "control");
                notify(run.id);
                throw new UncertainWriteError(resolution);
              }
              await store.update(run.id, (value) => {
                const index = value.steps.findIndex((step) => step.key === key);
                value.steps[index] = { ...value.steps[index], status: "failed", error: message, retryable: false, usage: usage(native) } as WorkflowStep;
              }, "control");
              throw new Error(message);
            }
            await store.update(run.id, (value) => {
              const index = value.steps.findIndex((step) => step.key === key);
              value.steps[index] = { ...value.steps[index], status: "completed", completed: Date.now(), report, usage: usage(native) } as WorkflowStep;
            });
            return report.result;
          };
          let recorded = await ctx.storage.get(resultKey(current.workerID));
          if (recorded === undefined) {
            if (current.status === "failed") {
              if (!current.retryable) throw new Error(current.error);
              await workers.send(run.ownerID, {
                workerID: Session.ID.make(current.workerID),
                key: `workflow-retry:${run.id}:${key}`,
                text: "The previous native execution failed before a valid workflows_result report was recorded. Inspect the existing session work, repair the issue, and call workflows_result. Do not redo already-completed external effects.",
              });
            } else {
              const native = await ctx.session.get({ sessionID: current.workerID }).catch(() => undefined);
              if (current.status === "running" && native?.outcome !== undefined) {
                if (input.access === "write") {
                  const message = "Interrupted write has uncertain external state. Inspect the retained worker/worktree and send that same worker an explicit resolution request; after it reports, resume this run. The write will not be replayed automatically.";
                  await store.update(run.id, (value) => { value.status = "interrupted"; value.error = message; }, "control");
                  throw new UncertainWriteError(message);
                }
                await workers.send(run.ownerID, {
                  workerID: Session.ID.make(current.workerID),
                  key: `workflow-reconcile:${run.id}:${key}`,
                  text: "The service resumed this read-only step after its prior execution ended without a validated report. Inspect the existing context, finish the task, and call workflows_result.",
                });
              }
            }
          }
          await store.update(run.id, (value) => {
            const index = value.steps.findIndex((step) => step.key === key);
            if (index >= 0 && value.steps[index].status !== "completed") value.steps[index] = { ...value.steps[index], status: "running" } as WorkflowStep;
          }, "control");
          const agentTimeout = input.timeoutMs ?? run.limits.agentTimeoutMs;
          const deadline = Date.now() + agentTimeout;
          const deadlineReason = () => controller.signal.aborted
            ? controller.signal.reason ?? new Error("Workflow cancelled")
            : Date.now() >= deadline ? new Error(`Workflow worker timed out after ${agentTimeout}ms`) : undefined;
          const waitWorker = async () => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let abort = () => {};
            let forcedReason: unknown;
            let interrupt: Promise<void> | undefined;
            const force = (reason: unknown) => {
              if (forcedReason === undefined) {
                forcedReason = reason;
                interrupt = Promise.resolve().then(() => workers.interrupt(run.ownerID, { workerID: Session.ID.make(current.workerID) }))
                  .then(() => undefined, () => undefined);
              }
            };
            try {
              await Promise.race([
                ctx.session.wait({ sessionID: current.workerID }),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => {
                    const reason = new Error(`Workflow worker timed out after ${agentTimeout}ms`);
                    force(reason);
                    reject(reason);
                  }, Math.max(0, deadline - Date.now()));
                }),
                new Promise<never>((_, reject) => {
                  abort = () => {
                    const reason = controller.signal.reason ?? new Error("Workflow cancelled");
                    force(reason);
                    reject(reason);
                  };
                  controller.signal.addEventListener("abort", abort, { once: true });
                  if (controller.signal.aborted) abort();
                }),
              ]);
              const reason = forcedReason ?? deadlineReason();
              if (reason !== undefined) { force(reason); throw reason; }
            } catch (error) {
              const reason = forcedReason ?? deadlineReason();
              if (reason !== undefined) { force(reason); throw reason; }
              throw error;
            } finally {
              if (timeout !== undefined) clearTimeout(timeout);
              controller.signal.removeEventListener("abort", abort);
              await interrupt;
            }
          };
          await waitWorker();
          recorded ??= await ctx.storage.get(resultKey(current.workerID));
          if (recorded === undefined) {
            const native = await ctx.session.get({ sessionID: current.workerID });
            if (native.outcome === "succeeded" || (input.access === "read" && (native.outcome === "failed" || native.outcome === "interrupted"))) {
              const reason = deadlineReason();
              if (reason !== undefined) {
                await workers.interrupt(run.ownerID, { workerID: Session.ID.make(current.workerID) }).catch(() => undefined);
                throw reason;
              }
              await workers.send(run.ownerID, {
                workerID: Session.ID.make(current.workerID),
                key: `workflow-report-repair:${run.id}:${key}`,
                text: native.outcome === "succeeded"
                  ? "Your native execution completed without a validated workflows_result. Do not redo the task. Review the existing work and submit the required structured report now."
                  : "The read-only execution ended before a validated report was recorded. Inspect the existing context, repair or finish the read, and submit workflows_result without creating a new worker.",
              });
              await waitWorker();
              recorded = await ctx.storage.get(resultKey(current.workerID));
            }
          }
          if (recorded === undefined) {
            const native = await ctx.session.get({ sessionID: current.workerID });
            const message = native.outcome === "succeeded"
              ? "Worker completed without a workflows_result report; native success is not workflow success"
              : `Worker ended ${native.outcome ?? "without a terminal outcome"} before a valid workflows_result report`;
            await store.update(run.id, (value) => {
              const index = value.steps.findIndex((step) => step.key === key);
              value.steps[index] = { ...value.steps[index], status: "failed", error: message, retryable: input.access === "read", usage: usage(native) } as WorkflowStep;
            }, "control");
            throw new Error(message);
          }
          return finishRecorded(recorded);
        };
        active++;
        try {
          const attempt = () => withWorkflowSlot(
            run.ownerID,
            maxWorkers,
            run.id,
            run.limits.concurrency,
            controller.signal,
            dispatch,
          );
          const perform = async (): Promise<Json> => {
            for (;;) {
              await waitUntilRunnable(run.id, controller.signal);
              try {
                return await (input.access === "write" && input.isolation === "shared"
                  ? serialized(`workflow-write:${directory}`, attempt)
                  : attempt()) as Json;
              } catch (error) {
                if (!(error instanceof SchedulingDeferred)) throw error;
              }
            }
          };
          const pending = perform();
          pendingAgents.add(pending);
          try {
            const existing = recordedSettlement("agent", key);
            let value: Json | undefined;
            let failure: unknown;
            try {
              value = await pending;
            } catch (error) {
              failure = error;
            }
            if (failure !== undefined) {
              if (failure instanceof UncertainWriteError) throw failure;
              const state = await store.get(run.id);
              if (state.status === "interrupted" || state.status === "stopping" || state.status === "stopped") throw failure;
              if (existing?.kind === "agent" && existing.outcome === "success") throw failure;
              if (!(failure instanceof AdmissionDenied)) {
                await store.update(run.id, (value) => {
                  if (value.status === "interrupted") return;
                  const index = value.steps.findIndex((step) => step.key === key);
                  const step = value.steps[index];
                  if (step && step.status !== "completed" && step.status !== "failed") {
                    value.steps[index] = { ...step, status: "failed", error: errorText(failure), retryable: input.access === "read" } as WorkflowStep;
                  }
                }, "control");
              }
              if (!existing) await appendSettlement({ kind: "agent", key, outcome: "failure", error: settlementError(failure) });
              const settlement = await consumeSettlement("agent", key);
              throw new Error(settlement.kind === "agent" && settlement.outcome === "failure" ? settlement.error ?? errorText(failure) : errorText(failure));
            }
            if (!existing) await appendSettlement({ kind: "agent", key, outcome: "success" });
            const settlement = await consumeSettlement("agent", key);
            if (settlement.kind === "agent" && settlement.outcome === "failure") throw new Error(settlement.error ?? `Workflow step ${key} previously failed`);
            return value!;
          } finally {
            pendingAgents.delete(pending);
          }
        } catch (error) {
          throw error;
        } finally {
          active--;
          const latest = await store.get(run.id);
          if (active === 0 && latest.status === "pausing") await store.update(run.id, (value) => { if (value.status === "pausing") value.status = "paused"; }, "control");
        }
      },
      phase: async (title) => {
        countCall();
        const phase = bounded(String(title), 160);
        await store.update(runID, (current) => { current.phase = phase; });
      },
      log: async (message) => {
        countCall();
        await store.update(runID, (current) => {
          current.logs.push({ time: Date.now(), text: bounded(String(message), 2_000) });
          if (current.logs.length > 200) current.logs.splice(0, current.logs.length - 200);
        });
      },
      checkpoint: async (raw) => {
        countCall();
        const request = raw as { key?: unknown; prompt?: unknown };
        const localKey = String(request.key ?? "");
        const key = `${prefix}${localKey}`;
        const prompt = bounded(String(request.prompt ?? ""), 10_000);
        if (!localKey || !prompt) throw new Error("Checkpoint requires non-empty key and prompt");
        const checkpoint = await store.update(runID, (current) => {
          const checkpoint = current.checkpoints.find((item) => item.key === key);
          if (checkpoint && checkpoint.prompt !== prompt) throw new Error(`Checkpoint ${key} changed on resume`);
          if (!checkpoint) current.checkpoints.push({ key, prompt });
          if (checkpoint?.response === undefined && current.status === "running") current.status = "waiting";
        });
        const recorded = checkpoint.checkpoints.find((item) => item.key === key)!;
        const reconcileSettlement = async () => {
          await refreshSettlements();
          const settlement = recordedSettlement("checkpoint", key);
          if (settlement?.kind !== "checkpoint") return undefined;
          const reconciled = await store.update(runID, (current) => {
            const item = current.checkpoints.find((candidate) => candidate.key === key);
            if (!item) throw new Error(`Checkpoint ${key} settlement has no matching checkpoint`);
            if (item.response !== undefined && JSON.stringify(item.response) !== JSON.stringify(settlement.response)) {
              throw new Error(`Checkpoint ${key} response conflicts with its durable settlement`);
            }
            item.response = settlement.response;
            if (current.status === "running" || current.status === "waiting") {
              current.status = current.checkpoints.some((candidate) => candidate.response === undefined) ? "waiting" : "running";
            }
          });
          notify(runID);
          const ordered = await consumeSettlement("checkpoint", key);
          return ordered.kind === "checkpoint"
            ? ordered.response
            : reconciled.checkpoints.find((item) => item.key === key)!.response;
        };
        if (recorded.response !== undefined) {
          const response = await reconcileSettlement();
          if (response === undefined) throw new Error(`Checkpoint ${key} has a response but no deterministic settlement record`);
          return response;
        }
        for (;;) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const reconciled = await reconcileSettlement();
          if (reconciled !== undefined) return reconciled;
          const current = await store.get(runID);
          const checkpoint = current.checkpoints.find((item) => item.key === key)!;
          if (checkpoint.response !== undefined) {
            const raced = await reconcileSettlement();
            if (raced !== undefined) return raced;
            throw new Error(`Checkpoint ${key} has a response but no deterministic settlement record`);
          }
          await waitForChange(runID, controller.signal);
        }
      },
      workflow: async (input) => {
        countCall();
        if (depth >= 4) throw new Error("Nested workflow depth limit reached (4)");
        if (!options.loadSaved) throw new Error("Saved workflow loading is not configured");
        const scope = `${prefix}workflow:${input.name}`;
        const index = nestedIndexes.get(scope) ?? 0;
        nestedIndexes.set(scope, index + 1);
        const identity = `${scope}:${index}`;
        const key = nestedKey(run.id, identity);
        const existing = await ctx.storage.get(key);
        let script: string;
        if (existing === undefined) {
          const loaded = await options.loadSaved(input.name);
          const pinned = { name: input.name, identity, script: loaded, fingerprint: digest(loaded) };
          await serialized(key, async () => {
            const raced = await ctx.storage.get(key);
            if (raced === undefined) await ctx.storage.set(key, Json.parse(pinned));
          });
          const durable = await ctx.storage.get(key) as Partial<typeof pinned> | undefined;
          if (durable?.name !== input.name || durable.identity !== identity || typeof durable.script !== "string" || durable.fingerprint !== digest(durable.script)) {
            throw new Error(`Nested workflow pin ${identity} is invalid`);
          }
          script = durable.script;
        } else {
          const durable = existing as { name?: unknown; identity?: unknown; script?: unknown; fingerprint?: unknown };
          if (durable.name !== input.name || durable.identity !== identity || typeof durable.script !== "string" || durable.fingerprint !== digest(durable.script)) {
            throw new Error(`Nested workflow pin ${identity} is invalid`);
          }
          script = durable.script;
        }
        parseWorkflow(script);
        return executeWorkflow({
          script,
          args: input.args ?? null,
          signal: controller.signal,
          host: hostFor(`${prefix}workflow:${input.name}:${index}/`, depth + 1),
          maxCalls,
          timeoutMs: remaining,
        });
      },
    });
    try {
      const output = await executeWorkflow({
        script: run.script, args: run.args, signal: controller.signal,
        host: hostFor("", 0), maxCalls, timeoutMs: remaining,
      });
      const latest = await store.get(runID);
      if (latest.status === "stopping" || latest.status === "stopped") {
        await store.update(runID, (current) => { current.status = "stopped"; }, "control");
      } else if (latest.status === "pausing" || latest.status === "paused") {
        await store.update(runID, (current) => { current.status = "paused"; }, "control");
      } else {
        const unresolved = latest.steps.find((step) => step.status !== "completed");
        if (unresolved) throw new Error(`Workflow cannot complete with unresolved step ${unresolved.key} (${unresolved.status})`);
        const adverse = latest.steps.filter(isCompleted).find((step) => step.report.verdict === "FAIL" || step.report.verdict === "INCONCLUSIVE");
        if (adverse) throw new Error(`Step ${adverse.key} reported ${adverse.report.verdict}: ${adverse.report.summary}`);
        await store.update(runID, (current) => {
          current.status = "completed";
          if (output === undefined) delete current.result;
          else current.result = boundedJson(output, "Workflow result");
          delete current.error;
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      const latest = await store.get(runID);
      await interruptWorkflowWorkers(workers, run.ownerID, latest);
      await Promise.allSettled([...pendingAgents]);
      await store.update(runID, (current) => {
        if (latest.status === "stopping" || latest.status === "stopped") current.status = "stopped";
        else if (latest.status === "paused" || latest.status === "interrupted") return;
        else { current.status = "failed"; current.error = errorText(error); }
      }, "control");
    } finally {
      clearTimeout(timer);
      const latest = await store.get(runID);
      if (terminal.has(latest.status)) await deliver(runID);
    }
  }

  return {
    async start(ownerID: string, raw: WorkflowStart, runtime: Runtime) {
      await recover(ownerID);
      const input = WorkflowStart.parse(raw);
      const owner = await ctx.session.get({ sessionID: ownerID });
      if (owner.parentID !== undefined || owner.metadata?.opThreads !== undefined) throw new Error("Only a root session may start workflows");
      const script = input.script ?? await options.loadSaved?.(input.name!);
      if (script === undefined) throw new Error("Saved workflow loading is not configured");
      const parsed = parseWorkflow(script);
      const id = runIdentity(ownerID, input.key);
      const fingerprint = workflowHash({ script, args: input.args, limits: {
        concurrency: input.concurrency, maxAgents: input.maxAgents,
        agentTimeoutMs: input.agentTimeoutMs, timeoutMs: input.timeoutMs,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      }, runtime });
      const now = Date.now();
      const run = WorkflowRun.parse({
        version: 1, id, key: input.key, ownerID, callerAgent: runtime.agent,
        model: runtime.model, projectID: owner.projectID, directory: owner.location.directory,
        name: parsed.meta.name, description: parsed.meta.description, script, args: input.args,
        fingerprint, limits: input, status: "running", created: now, updated: now,
        phase: parsed.meta.phases?.[0]?.title ?? "Starting", steps: [], logs: [], checkpoints: [],
        settlements: [],
        deliveryID: deliveryIdentity(id), delivered: false,
      });
      const admitted = await store.create(run);
      if (admitted.fingerprint !== fingerprint) throw new Error("This workflow key belongs to a different request");
      if (admitted === run) launch(id, runtime);
      return store.get(id);
    },
    async get(ownerID: string, runID: string) {
      await recover(ownerID);
      return owned(ownerID, runID);
    },
    async list(ownerID: string) {
      await recover(ownerID);
      return store.list(ownerID);
    },
    async control(ownerID: string, input: Control) {
      let checkpointReply: { key: string; response: Json } | undefined;
      if (input.action === "resume" && (input.checkpointKey !== undefined || input.response !== undefined)) {
        if (!input.checkpointKey || input.response === undefined) throw new Error("Checkpoint resume requires checkpointKey and response");
        checkpointReply = { key: input.checkpointKey, response: boundedJson(input.response, "Checkpoint response") };
      }
      return serialized(`workflow-control:${input.runID}`, async () => {
        await recover(ownerID);
        let run = await owned(ownerID, input.runID);
        if (input.action === "pause") {
          if (run.status !== "running") throw new Error(`Cannot pause workflow in ${run.status}`);
          run = await store.update(run.id, (current) => { current.status = "pausing"; }, "control");
          if (!run.steps.some((step) => step.status === "running")) run = await store.update(run.id, (current) => { current.status = "paused"; }, "control");
        } else if (input.action === "stop") {
          if (!terminal.has(run.status)) {
            run = await store.update(run.id, (current) => { current.status = "stopping"; }, "control");
            leases.get(run.id)?.controller.abort(new Error("Workflow stopped"));
            await interruptWorkflowWorkers(workers, ownerID, run);
            await leases.get(run.id)?.promise.catch(() => {});
            run = await store.update(run.id, (current) => { current.status = "stopped"; }, "control");
            await deliver(run.id);
          }
        } else {
          if (run.status === "interrupted") {
            await leases.get(run.id)?.promise.catch(() => {});
            run = await owned(ownerID, run.id);
          }
          const recovering = run.status === "interrupted";
          if (checkpointReply !== undefined) {
            const { key, response } = checkpointReply;
            if (terminal.has(run.status) || run.status === "stopping") throw new Error(`Cannot answer a checkpoint in ${run.status}`);
            const stored = await ctx.storage.get(completionKey(run.id));
            run = await store.update(run.id, (current) => {
              if (terminal.has(current.status) || current.status === "stopping") throw new Error(`Cannot answer a checkpoint in ${current.status}`);
              const checkpoint = current.checkpoints.find((item) => item.key === key);
              if (!checkpoint) throw new Error(`Checkpoint ${key} not found`);
              if (checkpoint.response !== undefined && JSON.stringify(checkpoint.response) !== JSON.stringify(response)) throw new Error("Checkpoint already has a different response");
              const settlements = readSettlements(current, stored);
              const existing = settlements.find((item) => item.kind === "checkpoint" && item.key === key);
              if (existing?.kind === "checkpoint" && JSON.stringify(existing.response) !== JSON.stringify(response)) {
                throw new Error("Checkpoint already has a different response");
              }
              current.settlements = existing ? settlements : [...settlements, { kind: "checkpoint", key, response }];
              assertSettlementLimit(current.settlements);
              checkpoint.response = response;
              current.status = current.checkpoints.some((item) => item.response === undefined) ? "waiting" : "running";
              delete current.error;
            });
          } else {
            if (!["paused", "interrupted"].includes(run.status)) {
              if (run.status === "waiting") throw new Error("Waiting workflow requires checkpointKey and response");
              throw new Error(`Cannot resume workflow in ${run.status}`);
            }
            run = await store.update(run.id, (current) => { current.status = "running"; delete current.error; }, "control");
          }
          notify(run.id);
          launch(run.id, { agent: run.callerAgent, model: run.model }, recovering);
        }
        notify(run.id);
        return run;
      });
    },
    async result(workerID: string, raw: WorkflowResult) {
      const session = await ctx.session.get({ sessionID: workerID });
      workerLink(session);
      const metadata = WorkflowWorker.parse(session.metadata?.opWorkflow);
      if (metadata.ownerID === workerID) throw new Error("Invalid workflow worker ownership");
      const run = await owned(metadata.ownerID, metadata.runID);
      if (run.status === "stopping" || terminal.has(run.status)) throw new Error(`Workflow ${run.id} is no longer accepting results`);
      const step = run.steps.find((item) => item.workerID === workerID && item.key === metadata.stepKey);
      if (!step) throw new Error("Workflow result does not match its server-recorded step");
      const input = WorkflowResult.parse(raw);
      if (input.summary.length > 20_000 || input.evidence.length > 100 || input.evidence.some((item) => item.length > 20_000)) {
        throw new Error("Workflow report exceeds its bounded summary or evidence limits");
      }
      boundedJson(input, "Workflow worker report");
      if (step.input.schema !== undefined) {
        const validate = ajv.compile(step.input.schema);
        if (!validate(input.result)) throw new Error(`Workflow result schema validation failed: ${ajv.errorsText(validate.errors)}`);
      }
      await serialized(resultKey(workerID), async () => {
        const existing = await ctx.storage.get(resultKey(workerID));
        if (existing !== undefined && JSON.stringify(WorkflowResult.parse(existing)) !== JSON.stringify(input)) throw new Error("This worker already reported a different workflow result");
        await ctx.storage.set(resultKey(workerID), Json.parse(input));
      });
      await workers.reportWorkflow(workerID, input);
      return { accepted: true as const };
    },
    async preparePrompt(sessionID: string, messageID: string) {
      await workers.prepareWorkflowPrompt(sessionID, messageID);
    },
    async prepareContext(sessionID: string) {
      const session = await ctx.session.get({ sessionID });
      const metadata = WorkflowWorker.safeParse(session.metadata?.opWorkflow);
      if (!metadata.success) return;
      workerLink(session);
      const run = await owned(metadata.data.ownerID, metadata.data.runID);
      const step = run.steps.find((item) =>
        item.workerID === sessionID && item.key === metadata.data.stepKey
      );
      if (!step) throw new Error("Workflow worker context does not match its durable step");
      const lease = leases.get(run.id);
      const leased = lease !== undefined && !lease.controller.signal.aborted && !terminal.has(run.status);
      watchWorkflowExecution(sessionID, () => ctx.session.wait({ sessionID }));
      if (!leased && !workflowExecutionAuthorized(sessionID)) {
        throw new Error(
          "Workflow worker generation is blocked until its owning workflow is explicitly resumed or the owner sends an authorized follow-up.",
        );
      }
    },
    async dispose() {
      disposed = true;
      const pending: Promise<void>[] = [];
      for (const [runID, lease] of leases) {
        if (lease.owner !== engineOwner) continue;
        await store.update(runID, (run) => {
          if (!terminal.has(run.status)) {
            run.status = "interrupted";
            run.error = "Workflow engine disposed while the run was active; resume explicitly.";
          }
        }, "control");
        lease.controller.abort(new Error("Workflow engine disposed"));
        pending.push(lease.promise.catch(() => {}));
      }
      await Promise.all(pending);
    },
  };
}
