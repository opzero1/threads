import { executeWorkflowInterpreter, type WorkflowHost } from "./workflow-runtime-interpreter";
import { assertBoundedMessage, boundedDiagnostic, type HostMethod, type ParentToWorker, type ScriptState, type WorkerToParent } from "./workflow-runtime-protocol";

declare const self: {
  onmessage: ((event: MessageEvent<ParentToWorker>) => void) | null;
  postMessage(message: WorkerToParent): void;
};

const controller = new AbortController();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextID = 1;
let started = false;
let phase: string | undefined;
let logs: string[] = [];

function send(message: WorkerToParent): void {
  self.postMessage(message);
}

function state(): ScriptState {
  const taken = logs;
  logs = [];
  return { phase, logs: taken };
}

function hostCall(method: HostMethod, input: unknown): Promise<unknown> {
  assertBoundedMessage(input, `Workflow ${method} request`);
  const id = nextID++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "hostCall", id, method, input, ...state() });
  });
}

const host: WorkflowHost = {
  agent: (input) => hostCall("agent", input),
  phase: (title) => { phase = title; },
  log: (message) => {
    logs.push(message);
    // The run keeps only its latest 200 log lines.
    if (logs.length > 200) logs.splice(0, logs.length - 200);
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
      send({ type: "result", ok: true, value, ...state() });
    } catch (error) {
      send({ type: "result", ok: false, error: boundedDiagnostic(error), ...state() });
    }
  })();
};
