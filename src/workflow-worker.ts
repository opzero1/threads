import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { Session } from "@opencode/schema/session";
import type { threads } from "./threads";
import type { WorkflowAgentInput, WorkflowRun } from "./workflow-types";

type Threads = ReturnType<typeof threads>;
type Waiter = {
  limit: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
};
type Semaphore = { active: number; queue: Waiter[] };

const globalState = globalThis as typeof globalThis & {
  __opWorkflowOwnerSlots?: Map<string, Semaphore>;
  __opWorkflowRunSlots?: Map<string, Semaphore>;
};
const ownerSlots = globalState.__opWorkflowOwnerSlots ??= new Map();
const runSlots = globalState.__opWorkflowRunSlots ??= new Map();

async function acquire(
  states: Map<string, Semaphore>,
  key: string,
  limit: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw signal.reason ?? new Error("Workflow cancelled");
  const state = states.get(key) ?? { active: 0, queue: [] };
  states.set(key, state);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.active--;
    for (;;) {
      const waiter = state.queue[0];
      if (!waiter || state.active >= waiter.limit) break;
      state.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error("Workflow cancelled"));
        continue;
      }
      state.active++;
      waiter.resolve(releaseFor(states, key, state));
    }
    if (state.active === 0 && state.queue.length === 0) states.delete(key);
  };
  if (state.active < limit) {
    state.active++;
    return release;
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      limit,
      signal,
      resolve,
      reject,
      abort: () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal.reason ?? new Error("Workflow cancelled"));
        if (state.active === 0 && state.queue.length === 0) states.delete(key);
      },
    };
    state.queue.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}

function releaseFor(states: Map<string, Semaphore>, key: string, state: Semaphore) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active--;
    for (;;) {
      const waiter = state.queue[0];
      if (!waiter || state.active >= waiter.limit) break;
      state.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error("Workflow cancelled"));
        continue;
      }
      state.active++;
      waiter.resolve(releaseFor(states, key, state));
    }
    if (state.active === 0 && state.queue.length === 0) states.delete(key);
  };
}

export async function withWorkflowSlot<T>(
  ownerID: string,
  ownerLimit: number,
  runID: string,
  runLimit: number,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const releaseRun = await acquire(runSlots, runID, runLimit, signal);
  try {
    const releaseOwner = await acquire(ownerSlots, ownerID, ownerLimit, signal);
    try {
      return await run();
    } finally {
      releaseOwner();
    }
  } finally {
    releaseRun();
  }
}

function safePrefix(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28);
}

export function workflowDirectoryPlan(
  run: WorkflowRun,
  input: WorkflowAgentInput,
  namespacedKey: string,
) {
  const source = input.directory ?? run.directory;
  if (input.isolation === "shared") return { source, directory: source };
  if (input.access !== "write") {
    throw new Error("Worktree isolation is only supported for explicit write steps");
  }
  const hash = createHash("sha256").update(namespacedKey).digest("hex").slice(0, 16);
  const name = `workflow-${run.id.slice(-10)}-${safePrefix(namespacedKey)}-${hash}`;
  const parent = join(dirname(source), ".opencode-workflows");
  return { source, name, parent, directory: join(parent, name) };
}

function inside(path: string, root: string) {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function workflowSourceDirectory(
  ctx: Pick<Plugin.Context, "worktree">,
  run: WorkflowRun,
  input: WorkflowAgentInput,
) {
  const source = await realpath(input.directory ?? run.directory);
  const roots = [await realpath(run.directory)];
  for (const entry of await ctx.worktree.list({ projectID: run.projectID })) {
    try {
      roots.push(await realpath(entry.directory));
    } catch {
      // Ignore stale inventory entries. They cannot authorize a real source directory.
    }
  }
  if (!roots.some((root) => inside(source, root))) {
    throw new Error("Workflow directory must be inside the owner project or one of its registered worktrees");
  }
  return source;
}

export async function workflowDirectory(
  ctx: Pick<Plugin.Context, "worktree">,
  run: WorkflowRun,
  input: WorkflowAgentInput,
  namespacedKey: string,
): Promise<string> {
  const plan = workflowDirectoryPlan(run, input, namespacedKey);
  if (input.isolation === "shared") return plan.directory;
  const inventory = await ctx.worktree.list({ projectID: run.projectID });
  if (inventory.some((entry) => entry.directory === plan.directory)) return plan.directory;
  try {
    const created = await ctx.worktree.create({
      projectID: run.projectID,
      from: plan.source,
      directory: plan.parent,
      name: plan.name,
    });
    if (created.directory !== plan.directory) {
      throw new Error(`Worktree strategy returned non-canonical directory ${created.directory}; expected ${plan.directory}`);
    }
    return created.directory;
  } catch (error) {
    const reconciled = (await ctx.worktree.list({ projectID: run.projectID }))
      .find((entry) => entry.directory === plan.directory);
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
