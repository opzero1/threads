export const WORKFLOW_MESSAGE_LIMIT_BYTES = 1024 * 1024;
export const WORKFLOW_DIAGNOSTIC_LIMIT = 8_192;

export type HostMethod = "agent" | "phase" | "log" | "checkpoint" | "workflow";

export type ParentToWorker =
  | { type: "start"; script: string; args: unknown; maxCalls?: number; timeoutMs?: number }
  | { type: "hostResult"; id: number; ok: true; value: unknown }
  | { type: "hostResult"; id: number; ok: false; error: string };

export type WorkerToParent =
  | { type: "hostCall"; id: number; method: HostMethod; input: unknown }
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error: string };

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
