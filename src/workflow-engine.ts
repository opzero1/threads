import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import Ajv from "ajv";
import { parseWorkflow, executeWorkflow, type WorkflowHost } from "./workflow-runtime";
import { requireDelegation } from "./permissions";
import { serialized, type threads, WorkflowWorker, workerIdentity, workerLink } from "./threads";
import { workflowHash, workflowStore } from "./workflow-store";
import {
  Json,
  WorkflowAgentInput,
  WorkflowResult,
  WorkflowRun,
  WorkflowStart,
  type WorkflowStep,
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
};
const leases = processState.__opWorkflowLeases ??= new Map();
const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const runIdentity = (ownerID: string, key: string) => `wfr_${digest(ownerID, key).slice(0, 32)}`;
const deliveryIdentity = (runID: string) => SessionMessage.ID.make(`msg_${digest(runID, "delivery").slice(0, 32)}`);
const resultKey = (workerID: string) => `workflows/results/${workerID}`;
const nestedKey = (runID: string, identity: string) => `workflows/nested/${runID}/${digest(identity)}`;
const completionKey = (runID: string) => `workflows/completions/${runID}`;
const terminal = new Set(["stopped", "failed", "completed"]);
const activeStatus = new Set(["running", "pausing", "stopping", "waiting"]);
const bounded = (text: string, length = 20_000) => text.length <= length ? text : `${text.slice(0, length)}\n…[truncated]`;
const isCompleted = (step: WorkflowStep): step is Extract<WorkflowStep, { status: "completed" }> => step.status === "completed";
function boundedJson(value: unknown, label: string) {
  const parsed = Json.parse(value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 1_048_576) {
    throw new Error(`${label} exceeds the 1 MiB durable output limit`);
  }
  return parsed;
}

function errorText(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error));
}

class UncertainWriteError extends Error {}

function usage(session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>) {
  const tokens = session.tokens;
  const measured = tokens !== undefined && session.cost !== undefined;
  return {
    tokens: measured
      ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
      : 0,
    cost: measured ? session.cost : 0,
    measured,
  };
}

export function workflowEngine(
  ctx: Plugin.Context,
  workers: Threads,
  options: { maxWorkers?: number; loadSaved?: (name: string) => Promise<string> } = {},
) {
  const store = workflowStore(ctx.storage);
  const maxWorkers = options.maxWorkers ?? 4;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) throw new Error("maxWorkers must be a positive integer");
  const ajv = new Ajv({ allErrors: true, strict: false });
  const recoveredOwners = new Set<string>();
  const engineOwner = Symbol("workflow-engine");
  let disposed = false;

  async function owned(ownerID: string, runID: string) {
    const run = await store.get(runID);
    if (run.ownerID !== ownerID) throw new Error("Only the owning session may access this workflow");
    return run;
  }

  async function deliver(runID: string) {
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
    return store.update(run.id, (current) => { current.delivered = true; });
  }

  async function recover(ownerID: string) {
    const runs = await store.list(ownerID);
    if (!recoveredOwners.has(ownerID)) {
      recoveredOwners.add(ownerID);
      for (const run of runs) {
        if (activeStatus.has(run.status) && !leases.has(run.id)) {
          await store.update(run.id, (current) => {
            current.status = "interrupted";
            current.error = "OpenCode stopped while this workflow was active. Inspect its recorded steps, then resume explicitly.";
          });
        }
      }
    }
    for (const run of await store.list(ownerID)) {
      if (terminal.has(run.status) && !run.delivered) await deliver(run.id);
    }
  }

  async function waitUntilRunnable(runID: string, signal: AbortSignal) {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("Workflow cancelled");
      const run = await store.get(runID);
      if (run.status === "running") return;
      if (run.status === "stopping" || run.status === "stopped") throw new Error("Workflow stopped");
      if (run.status === "pausing" && !run.steps.some((step) => step.status === "running")) {
        await store.update(runID, (current) => { if (current.status === "pausing") current.status = "paused"; });
      }
      await Bun.sleep(25);
    }
  }

  async function resolveWorktree(run: WorkflowRun, input: WorkflowAgentInput, key: string) {
    return serialized(`workflow-worktree:${run.id}:${key}`, () => workflowDirectory(ctx, run, input, key));
  }

  function launch(runID: string, runtime: Runtime) {
    if (disposed || leases.has(runID)) return leases.get(runID)?.promise;
    const controller = new AbortController();
    const task = executeRun(runID, runtime, controller).finally(() => {
      if (leases.get(runID)?.promise === task) leases.delete(runID);
    });
    leases.set(runID, { controller, promise: task, owner: engineOwner });
    void task.catch(() => {});
    return task;
  }

  async function executeRun(runID: string, runtime: Runtime, controller: AbortController) {
    let run = await store.get(runID);
    const remaining = run.created + run.limits.timeoutMs - Date.now();
    if (remaining <= 0) {
      await store.update(runID, (current) => { current.status = "failed"; current.error = "Workflow timeout exceeded"; });
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
    const storedCompletionOrder = await ctx.storage.get(completionKey(runID));
    let completionOrder = storedCompletionOrder === undefined
      ? []
      : Json.parse(storedCompletionOrder) as Json[];
    if (!completionOrder.every((key) => typeof key === "string")) throw new Error("Workflow completion order journal is invalid");
    let completionCursor = 0;
    const orderedResult = async (key: string, value: Json) => {
      await serialized(completionKey(runID), async () => {
        const stored = await ctx.storage.get(completionKey(runID));
        const durable = stored === undefined ? [] : Json.parse(stored) as Json[];
        if (!durable.every((item) => typeof item === "string")) throw new Error("Workflow completion order journal is invalid");
        if (!durable.includes(key)) {
          durable.push(key);
          await ctx.storage.set(completionKey(runID), durable);
        }
        completionOrder = durable;
      });
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (completionOrder[completionCursor] === key) {
          completionCursor++;
          return value;
        }
        await Bun.sleep(5);
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
          const completed = current.steps.filter(isCompleted);
          if (current.limits.tokenBudget !== undefined) {
            if (completed.some((step) => !step.usage.measured)) {
              throw new Error("Workflow token budget cannot continue because prior worker usage is unmeasured");
            }
            const consumed = completed.reduce((sum, step) => sum + step.usage.tokens, 0);
            if (consumed >= current.limits.tokenBudget) {
              throw new Error(`Workflow token budget reached (${current.limits.tokenBudget}); in-flight usage may overshoot the soft budget`);
            }
          }
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
        const directory = previous.profileFingerprint.startsWith("pending:")
          ? await resolveWorktree(run, directoryInput, key)
          : previous.directory;
        const spawnKey = previous.spawnKey;
        const dispatch = async () => {
          await waitUntilRunnable(run.id, controller.signal);
          let current = (await store.get(run.id)).steps.find((step) => step.key === key)!;
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
            });
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
              });
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
              await store.update(run.id, (value) => {
                const index = value.steps.findIndex((step) => step.key === key);
                value.steps[index] = { ...value.steps[index], status: "failed", error: message, retryable: false } as WorkflowStep;
              });
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
                  await store.update(run.id, (value) => { value.status = "interrupted"; value.error = message; });
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
          });
          const agentTimeout = input.timeoutMs ?? run.limits.agentTimeoutMs;
          const waitWorker = async () => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let abort = () => {};
            const interruptAndReject = (reject: (reason?: unknown) => void, reason: unknown) => {
              void workers.interrupt(run.ownerID, { workerID: Session.ID.make(current.workerID) })
                .then(() => reject(reason), () => reject(reason));
            };
            try {
              await Promise.race([
                ctx.session.wait({ sessionID: current.workerID }),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => {
                    interruptAndReject(reject, new Error(`Workflow worker timed out after ${agentTimeout}ms`));
                  }, agentTimeout);
                }),
                new Promise<never>((_, reject) => {
                  abort = () => {
                    interruptAndReject(reject, controller.signal.reason ?? new Error("Workflow cancelled"));
                  };
                  controller.signal.addEventListener("abort", abort, { once: true });
                  if (controller.signal.aborted) abort();
                }),
              ]);
            } finally {
              if (timeout !== undefined) clearTimeout(timeout);
              controller.signal.removeEventListener("abort", abort);
            }
          };
          await waitWorker();
          recorded ??= await ctx.storage.get(resultKey(current.workerID));
          if (recorded === undefined) {
            const native = await ctx.session.get({ sessionID: current.workerID });
            if (native.outcome === "succeeded" || (input.access === "read" && (native.outcome === "failed" || native.outcome === "interrupted"))) {
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
              value.steps[index] = { ...value.steps[index], status: "failed", error: message, retryable: input.access === "read" } as WorkflowStep;
            });
            throw new Error(message);
          }
          return finishRecorded(recorded);
        };
        active++;
        try {
          const perform = () => withWorkflowSlot(
            run.ownerID,
            maxWorkers,
            run.id,
            run.limits.concurrency,
            controller.signal,
            dispatch,
          );
          const pending = input.access === "write" && input.isolation === "shared"
            ? serialized(`workflow-write:${directory}`, perform)
            : perform();
          pendingAgents.add(pending);
          try {
            return await orderedResult(key, await pending as Json);
          } finally {
            pendingAgents.delete(pending);
          }
        } catch (error) {
          await store.update(run.id, (value) => {
            if (value.status === "interrupted") return;
            const index = value.steps.findIndex((step) => step.key === key);
            const step = value.steps[index];
            if (step && step.status !== "completed" && step.status !== "failed") {
              value.steps[index] = { ...step, status: "failed", error: errorText(error), retryable: input.access === "read" } as WorkflowStep;
            }
          });
          throw error;
        } finally {
          active--;
          const latest = await store.get(run.id);
          if (active === 0 && latest.status === "pausing") await store.update(run.id, (value) => { if (value.status === "pausing") value.status = "paused"; });
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
          if (checkpoint?.response === undefined) current.status = "waiting";
        });
        const recorded = checkpoint.checkpoints.find((item) => item.key === key)!;
        if (recorded.response !== undefined) return recorded.response;
        for (;;) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const current = await store.get(runID);
          const checkpoint = current.checkpoints.find((item) => item.key === key)!;
          if (checkpoint.response !== undefined) return checkpoint.response;
          await Bun.sleep(25);
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
        await store.update(runID, (current) => { current.status = "stopped"; });
      } else if (latest.status === "pausing" || latest.status === "paused") {
        await store.update(runID, (current) => { current.status = "paused"; });
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
      });
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
      return serialized(`workflow-control:${input.runID}`, async () => {
        await recover(ownerID);
        let run = await owned(ownerID, input.runID);
        if (input.action === "pause") {
          if (run.status !== "running") throw new Error(`Cannot pause workflow in ${run.status}`);
          run = await store.update(run.id, (current) => { current.status = "pausing"; });
          if (!run.steps.some((step) => step.status === "running")) run = await store.update(run.id, (current) => { current.status = "paused"; });
        } else if (input.action === "stop") {
          if (!terminal.has(run.status)) {
            run = await store.update(run.id, (current) => { current.status = "stopping"; });
            leases.get(run.id)?.controller.abort(new Error("Workflow stopped"));
            await interruptWorkflowWorkers(workers, ownerID, run);
            await leases.get(run.id)?.promise.catch(() => {});
            run = await store.update(run.id, (current) => { current.status = "stopped"; });
            await deliver(run.id);
          }
        } else {
          if (input.checkpointKey !== undefined || input.response !== undefined) {
            if (!input.checkpointKey || input.response === undefined) throw new Error("Checkpoint resume requires checkpointKey and response");
            if (terminal.has(run.status) || run.status === "stopping") throw new Error(`Cannot answer a checkpoint in ${run.status}`);
            run = await store.update(run.id, (current) => {
              const checkpoint = current.checkpoints.find((item) => item.key === input.checkpointKey);
              if (!checkpoint) throw new Error(`Checkpoint ${input.checkpointKey} not found`);
              if (checkpoint.response !== undefined && JSON.stringify(checkpoint.response) !== JSON.stringify(input.response)) throw new Error("Checkpoint already has a different response");
              checkpoint.response = Json.parse(input.response);
              current.status = "running";
              delete current.error;
            });
          } else {
            if (!["paused", "interrupted"].includes(run.status)) {
              if (run.status === "waiting") throw new Error("Waiting workflow requires checkpointKey and response");
              throw new Error(`Cannot resume workflow in ${run.status}`);
            }
            run = await store.update(run.id, (current) => { current.status = "running"; delete current.error; });
          }
          launch(run.id, { agent: run.callerAgent, model: run.model });
        }
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
        });
        lease.controller.abort(new Error("Workflow engine disposed"));
        pending.push(lease.promise.catch(() => {}));
      }
      await Promise.all(pending);
    },
  };
}
