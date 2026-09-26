import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { explicitDenies, projectRoot } from "./external-access";
import { permissionReaches } from "./permissions";
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

// `input.paths` must already be resolved grants; a step may run inside one of them. `granted` means
// that only a grant admits the directory, which then needs assertGrantedProject.
export async function workflowSource(
  ctx: Pick<Plugin.Context, "worktree">,
  run: WorkflowRun,
  input: WorkflowAgentInput,
) {
  const directory = await realpath(input.directory ?? run.directory);
  const owned = [await realpath(run.directory)];
  for (const entry of await ctx.worktree.list({ projectID: run.projectID })) {
    try {
      owned.push(await realpath(entry.directory));
    } catch {
      // Ignore stale inventory entries. They cannot authorize a real source directory.
    }
  }
  if (owned.some((root) => inside(directory, root))) return { directory, granted: false };
  if ((input.paths ?? []).some((root) => inside(directory, root))) return { directory, granted: true };
  throw new Error("Workflow directory must be inside the owner project, one of its registered worktrees, or a granted path");
}

// OpenCode checks external_directory only outside a worker's project. A step that a grant moves to
// `directory` makes that project local, so an explicit deny there, or on anything beneath it, stops
// applying. That project must stay within the grants and clear of explicit denies. `worktree` is a
// planned checkout that becomes the worker's own project.
export async function assertGrantedProject(
  inherited: Permission.Ruleset,
  role: Permission.Ruleset,
  paths: readonly string[] | undefined,
  directory: string,
  worktree?: string,
) {
  const root = await projectRoot(directory);
  assertWithinGrants(paths, directory, root);
  for (const local of worktree === undefined ? [root] : [root, worktree]) assertClearOfDenies(inherited, role, directory, local);
}

// The same rule where the worker actually runs, with the role that applies there. A worktree checkout
// that is its own project holds a copy of the granted source, so it needs no grant of its own.
export async function assertWorkerProject(
  inherited: Permission.Ruleset,
  role: Permission.Ruleset,
  paths: readonly string[] | undefined,
  directory: string,
  checkout: boolean,
) {
  const root = await projectRoot(directory);
  if (!checkout || root !== directory) assertWithinGrants(paths, directory, root);
  assertClearOfDenies(inherited, role, directory, root);
}

function assertWithinGrants(paths: readonly string[] | undefined, directory: string, root: string) {
  if (!(paths ?? []).some((path) => inside(root, path))) {
    throw new Error(`Workflow directory ${directory} is in project ${root}, which extends beyond its granted paths`);
  }
}

function assertClearOfDenies(inherited: Permission.Ruleset, role: Permission.Ruleset, directory: string, local: string) {
  const deny = explicitDenies(inherited, role).find((rule) => permissionReaches(rule.resource, local));
  if (deny) {
    throw new Error(`Workflow directory ${directory} would make ${local} local to its worker, where the explicit external_directory deny (${deny.resource}) cannot apply`);
  }
}

export async function workflowDirectory(
  ctx: Pick<Plugin.Context, "worktree">,
  run: WorkflowRun,
  input: WorkflowAgentInput,
  namespacedKey: string,
  projectID = run.projectID,
): Promise<string> {
  const plan = workflowDirectoryPlan(run, input, namespacedKey);
  if (input.isolation === "shared") return plan.directory;
  const inventory = await ctx.worktree.list({ projectID });
  if (inventory.some((entry) => entry.directory === plan.directory)) return plan.directory;
  try {
    const created = await ctx.worktree.create({
      projectID,
      from: plan.source,
      directory: plan.parent,
      name: plan.name,
    });
    if (created.directory !== plan.directory) {
      throw new Error(`Worktree strategy returned non-canonical directory ${created.directory}; expected ${plan.directory}`);
    }
    return created.directory;
  } catch (error) {
    const reconciled = (await ctx.worktree.list({ projectID }))
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
