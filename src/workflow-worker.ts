import { basename, dirname, join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import type { threads } from "./threads";
import type { WorkflowAgentInput, WorkflowRun } from "./workflow-types";

type Threads = ReturnType<typeof threads>;

const globalState = globalThis as typeof globalThis & {
  __opWorkflowOwnerSlots?: Map<string, { active: number; queue: Array<() => void> }>;
};
const ownerSlots = globalState.__opWorkflowOwnerSlots ??= new Map();

export async function withWorkflowSlot<T>(
  ownerID: string,
  limit: number,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const state = ownerSlots.get(ownerID) ?? { active: 0, queue: [] };
  ownerSlots.set(ownerID, state);
  if (state.active >= limit) {
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = state.queue.indexOf(admit);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal.reason ?? new Error("Workflow cancelled"));
      };
      state.queue.push(admit);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  if (signal.aborted) {
    state.queue.shift()?.();
    if (state.active === 0 && state.queue.length === 0) ownerSlots.delete(ownerID);
    throw signal.reason ?? new Error("Workflow cancelled");
  }
  state.active++;
  try {
    return await run();
  } finally {
    state.active--;
    state.queue.shift()?.();
    if (state.active === 0 && state.queue.length === 0) ownerSlots.delete(ownerID);
  }
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);
}

export async function workflowDirectory(
  ctx: Pick<Plugin.Context, "worktree">,
  run: WorkflowRun,
  input: WorkflowAgentInput,
  namespacedKey: string,
): Promise<string> {
  const source = input.directory ?? run.directory;
  if (input.isolation === "shared") return source;
  if (input.access !== "write") {
    throw new Error("Worktree isolation is only supported for explicit write steps");
  }
  const name = `workflow-${run.id.slice(-10)}-${safeName(namespacedKey)}`;
  const desired = join(dirname(source), ".opencode-workflows", name);
  const inventory = await ctx.worktree.list({ projectID: run.projectID });
  const existing = inventory.find((entry) =>
    entry.directory === desired || basename(entry.directory) === name
  );
  if (existing) return existing.directory;
  try {
    return (await ctx.worktree.create({
      projectID: run.projectID,
      from: source,
      directory: desired,
      name,
    })).directory;
  } catch (error) {
    const reconciled = (await ctx.worktree.list({ projectID: run.projectID }))
      .find((entry) => entry.directory === desired || basename(entry.directory) === name);
    if (reconciled) return reconciled.directory;
    throw error;
  }
}

export function workflowTask(input: WorkflowAgentInput) {
  const schema = input.schema === undefined
    ? "No additional result schema was supplied; return a JSON value appropriate to the task."
    : `The result field must validate against this JSON Schema:\n${JSON.stringify(input.schema)}`;
  return `${input.prompt}\n\n${schema}`;
}

export async function interruptWorkflowWorkers(
  workers: Threads,
  ownerID: string,
  run: WorkflowRun,
) {
  await Promise.allSettled(
    run.steps
      .filter((step) => step.status === "running" || step.status === "prepared")
      .map((step) => workers.interrupt(ownerID, { workerID: Session.ID.make(step.workerID) })),
  );
}
