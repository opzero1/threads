export const WORKFLOW_MESSAGE_LIMIT_BYTES = 1024 * 1024;
export const WORKFLOW_DIAGNOSTIC_LIMIT = 8_192;

export type HostMethod = "agent" | "checkpoint" | "workflow";

export const PHASE_LIMIT = 160;
export const LOG_LIMIT = 2_000;

// `outstanding` counts the progress messages the worker has sent whose delivery to the host has
// not settled. It is shared memory, so the worker can read it while the script runs synchronously.
export type ParentToWorker =
  | { type: "start"; script: string; args: unknown; timeoutMs?: number; outstanding: Int32Array }
  | { type: "hostResult"; id: number; ok: true; value: unknown }
  | { type: "hostResult"; id: number; ok: false; error: string };

// phase() and log() send progress without waiting for the host. hostCall carries the
// script's current phase, which labels the agent or workflow it starts.
export type WorkerToParent =
  | { type: "progress"; phase?: string; logs: string[] }
  | { type: "hostCall"; id: number; method: HostMethod; input: unknown; phase?: string }
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error: string };

export const bounded = (text: string, length = 20_000) => text.length <= length ? text : `${text.slice(0, length)}\n…[truncated]`;

export function boundedDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (Buffer.byteLength(message) <= WORKFLOW_DIAGNOSTIC_LIMIT) return message;
  const suffix = "… [truncated]";
  const prefixBytes = WORKFLOW_DIAGNOSTIC_LIMIT - Buffer.byteLength(suffix);
  let prefix = Buffer.from(message).subarray(0, prefixBytes).toString("utf8");
  while (Buffer.byteLength(prefix + suffix) > WORKFLOW_DIAGNOSTIC_LIMIT) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

export function assertBoundedMessage(value: unknown, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (encoded === undefined) encoded = "null";
  if (Buffer.byteLength(encoded) > WORKFLOW_MESSAGE_LIMIT_BYTES)
    throw new Error(`${label} exceeds ${WORKFLOW_MESSAGE_LIMIT_BYTES} bytes`);
}
