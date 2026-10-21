import { executeWorkflowInterpreter, type WorkflowHost } from "./workflow-runtime-interpreter";
import { assertBoundedMessage, bounded, boundedDiagnostic, LOG_LIMIT, PHASE_LIMIT, type HostMethod, type ParentToWorker, type WorkerToParent } from "./workflow-runtime-protocol";

declare const self: {
  onmessage: ((event: MessageEvent<ParentToWorker>) => void) | null;
  postMessage(message: WorkerToParent): void;
};

const controller = new AbortController();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextID = 1;
let started = false;
let phase: string | undefined;

// Progress waits here while 16 progress messages are outstanding, so phase() and log() alone
// cannot queue unbounded messages. A host call or the result sends waiting progress regardless.
// Waiting progress keeps the latest phase and 200 lines.
const PROGRESS_IN_FLIGHT = 16;
let outstanding: Int32Array = new Int32Array(1);
let progress: { phase?: string; logs: string[] } | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;

function send(message: WorkerToParent): void {
  self.postMessage(message);
}

function sendProgress(): void {
  if (!progress) return;
  Atomics.add(outstanding, 0, 1);
  send({ type: "progress", ...progress });
  progress = undefined;
}

function offerProgress(): void {
  if (!progress) return;
  if (Atomics.load(outstanding, 0) < PROGRESS_IN_FLIGHT) sendProgress();
  else retry ??= setTimeout(() => { retry = undefined; offerProgress(); }, 10);
}

function hostCall(method: HostMethod, input: unknown): Promise<unknown> {
  assertBoundedMessage(input, `Workflow ${method} request`);
  const id = nextID++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendProgress();
    send({ type: "hostCall", id, method, input, phase });
  });
}

const host: WorkflowHost = {
  agent: (input) => hostCall("agent", input),
  phase: (title) => {
    phase = bounded(title, PHASE_LIMIT);
    (progress ??= { logs: [] }).phase = phase;
    offerProgress();
  },
  log: (message) => {
    const logs = (progress ??= { logs: [] }).logs;
    logs.push(bounded(message, LOG_LIMIT));
    if (logs.length > 200) logs.shift();
    offerProgress();
  },
  checkpoint: (input) => hostCall("checkpoint", input),
  workflow: (input) => hostCall("workflow", input),
};

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "hostResult") {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.ok) operation.resolve(message.value);
    else operation.reject(new Error(message.error));
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  outstanding = message.outstanding;
  void (async () => {
    try {
      assertBoundedMessage(message.args, "Workflow arguments");
      const value = await executeWorkflowInterpreter({
        script: message.script,
        args: message.args,
        signal: controller.signal,
        host,
        timeoutMs: message.timeoutMs,
      });
      assertBoundedMessage(value, "Workflow result");
      sendProgress();
      send({ type: "result", ok: true, value });
    } catch (error) {
      sendProgress();
      send({ type: "result", ok: false, error: boundedDiagnostic(error) });
    }
  })();
};
