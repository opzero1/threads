export { parseWorkflow, validateBody } from "./workflow-runtime-interpreter";
export type { WorkflowMeta } from "./workflow-runtime-interpreter";

import {
  assertBoundedMessage,
  boundedDiagnostic,
  type HostMethod,
  type ParentToWorker,
  type ScriptState,
  type WorkerToParent,
} from "./workflow-runtime-protocol";

/**
 * `phase` and `log` record display state. The script's current phase, if it set one,
 * arrives as the third argument of `agent` and `workflow`.
 */
export type WorkflowHost = {
  agent(input: unknown, signal?: AbortSignal, phase?: string): Promise<unknown>;
  phase(title: string, signal?: AbortSignal): Promise<void>;
  log(message: string, signal?: AbortSignal): Promise<void>;
  checkpoint(input: unknown, signal?: AbortSignal): Promise<unknown>;
  workflow(input: { name: string; args?: unknown }, signal?: AbortSignal, phase?: string): Promise<unknown>;
};

type ExecuteInput = {
  script: string;
  args: unknown;
  signal: AbortSignal;
  host: WorkflowHost;
  timeoutMs?: number;
};

const MAX_RUNTIME_WORKERS = 64;
const HOST_DRAIN_GRACE_MS = 100;
let liveWorkers = 0;

function positiveOption(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function boundedDrain(operations: Set<Promise<void>>): Promise<void> {
  if (operations.size === 0) return;
  await Promise.race([
    Promise.allSettled([...operations]).then(() => undefined),
    Bun.sleep(HOST_DRAIN_GRACE_MS),
  ]);
}

/**
 * Runs parsing and CodeMode execution in a terminable worker. Host effects remain
 * in this process and receive an internal cancellation signal as an optional
 * second argument. At most 64 interpreter calls may coexist; excess fan-out fails
 * rather than waiting and deadlocking nested workflows.
 */
export async function executeWorkflow(input: ExecuteInput): Promise<unknown> {
  const timeoutMs = positiveOption(input.timeoutMs, "timeoutMs");
  if (input.signal.aborted) throw abortError(input.signal);
  if (liveWorkers >= MAX_RUNTIME_WORKERS) throw new Error(`Workflow runtime worker limit reached (${MAX_RUNTIME_WORKERS})`);
  const worker = new Worker(new URL("./workflow-runtime-worker.ts", import.meta.url), { type: "module" });
  liveWorkers++;
  const hostController = new AbortController();
  const operations = new Set<Promise<void>>();
  let acceptingCalls = true;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });

  const stop = (reason: unknown) => {
    if (settled) return;
    settled = true;
    acceptingCalls = false;
    hostController.abort(reason);
    void worker.terminate();
    rejectResult(reason);
  };
  const onAbort = () => stop(abortError(input.signal));
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => stop(new Error(`Workflow execution timed out after ${timeoutMs}ms`)), timeoutMs);
  }

  const invokeHost = (method: HostMethod, value: unknown, phase: string | undefined): Promise<unknown> => {
    switch (method) {
      case "agent": return input.host.agent(value, hostController.signal, phase);
      case "checkpoint": return input.host.checkpoint(value, hostController.signal);
      case "workflow": return input.host.workflow(value as { name: string; args?: unknown }, hostController.signal, phase);
    }
  };
  let displayedPhase: string | undefined;
  let delivered: Promise<void> = Promise.resolve();
  const deliver = (state: ScriptState): Promise<void> => {
    delivered = delivered.then(async () => {
      if (state.phase !== undefined && state.phase !== displayedPhase) {
        displayedPhase = state.phase;
        await input.host.phase(state.phase, hostController.signal);
      }
      for (const message of state.logs) await input.host.log(message, hostController.signal);
    });
    return delivered;
  };

  worker.onmessage = (event: MessageEvent<WorkerToParent>) => {
    const message = event.data;
    if (message.type === "hostCall") {
      if (!acceptingCalls) return;
      const operation = deliver(message).then(() => invokeHost(message.method, message.input, message.phase)).then(
        (value) => {
          if (!acceptingCalls) return;
          try {
            assertBoundedMessage(value, `Workflow ${message.method} response`);
            worker.postMessage({ type: "hostResult", id: message.id, ok: true, value } satisfies ParentToWorker);
          } catch (error) {
            worker.postMessage({ type: "hostResult", id: message.id, ok: false, error: `truncated: ${boundedDiagnostic(error)}` } satisfies ParentToWorker);
          }
        },
        (error) => {
          if (!acceptingCalls) return;
          worker.postMessage({ type: "hostResult", id: message.id, ok: false, error: boundedDiagnostic(error) } satisfies ParentToWorker);
        },
      );
      const tracked = operation.then(() => {}, () => {});
      operations.add(tracked);
      void tracked.finally(() => operations.delete(tracked));
      return;
    }
    if (message.type !== "result" || settled) return;
    settled = true;
    acceptingCalls = false;
    if (message.ok) void deliver(message).then(() => resolveResult(message.value), rejectResult);
    else {
      hostController.abort(new Error(message.error));
      const fail = () => rejectResult(new Error(message.error));
      void deliver(message).then(fail, fail);
    }
  };
  worker.onerror = (event: ErrorEvent) => stop(new Error(boundedDiagnostic(event.error ?? event.message)));

  try {
    worker.postMessage({ type: "start", script: input.script, args: input.args, timeoutMs } satisfies ParentToWorker);
    return await result;
  } finally {
    acceptingCalls = false;
    input.signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
    if (!hostController.signal.aborted) hostController.abort(new Error("Workflow runtime finished"));
    void worker.terminate();
    await boundedDrain(operations);
    liveWorkers--;
  }
}
