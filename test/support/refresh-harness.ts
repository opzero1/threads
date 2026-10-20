import type { Plugin as ServerPlugin } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin/tui";
import plugin from "../../tui";
import { workflowStore } from "../../src/workflow-store";
import { WorkflowRun, workflowSummary } from "../../src/workflow-types";
import type { WorkerView } from "../../src/rpc";

type Worker = import("zod").infer<typeof WorkerView>;
type Tab = { sessionID: string; title: string; active: boolean; busy: boolean; attention: boolean };
type Selection = { title: string; current?: unknown; options: readonly { title: string; description?: string; value: unknown }[] };

export const worker = (workerID: string, values: Partial<Worker> = {}): Worker => ({
  workerID, coordinatorID: "A", key: workerID, title: workerID, directory: "/fixture",
  agent: null, model: null, outcome: null, report: null, hidden: false, ...values,
});

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
export const streams = ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.compaction.delta", "session.step.streamed", "session.tool.progress"];

// Host boundaries only: production plugin setup/listeners, UI refresh and journal parsing run unchanged.
export async function refreshHarness(savedRuns = 0) {
  let owner = "A";
  let panel: { name: string; sessionID: string } | undefined;
  const records = new Map<string, Parameters<ServerPlugin.Context["storage"]["set"]>[1]>();
  const counts = { workflowSnapshots: 0, workerSnapshots: 0, inspections: 0, scans: 0, journalEntries: 0, journalBytes: 0 };
  const inspected: WorkflowRun[] = [];
  const storage: ServerPlugin.Context["storage"] = {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, structuredClone(value)); },
    remove: async (key) => { records.delete(key); },
    scan: async ({ prefix, after, limit }) => {
      counts.scans++;
      const keys = [...records.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort();
      const page = keys.slice(0, limit);
      counts.journalEntries += page.length;
      const entries = page.map((key) => ({ key, value: structuredClone(records.get(key)!) }));
      counts.journalBytes += entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0);
      return { entries, ...(keys.length > page.length ? { next: page.at(-1) } : {}) };
    },
  };
  const store = workflowStore(storage);
  for (let index = 0; index < savedRuns; index++) {
    await store.create(WorkflowRun.parse({
      version: 1, id: `run-${index}`, key: `run-${index}`, ownerID: index % 2 ? "B" : "A",
      callerAgent: "build", model: { providerID: "fixture", id: "fixture" }, projectID: "fixture",
      directory: "/fixture", name: `run-${index}`, description: "measurement", script: "return true", args: null,
      fingerprint: `fixture-${index}`, limits: { maxAgents: null, agentTimeoutMs: null, timeoutMs: null },
      status: "running", created: index, updated: index, phase: "starting", steps: [], logs: [], checkpoints: [],
      deliveryID: `delivery-${index}`, delivered: false,
    }));
  }
  const listeners = new Set<(event: { details: { type: string; data: { sessionID: string } } }) => void>();
  const commands = new Map<string, () => unknown>();
  const slots: (() => unknown)[] = [];
  const errors: unknown[] = [];
  let workerFailure: unknown;
  let holdWorkers: (() => unknown) | undefined;
  let workers: Worker[] = [];
  let delay: Promise<void> | undefined;
  let tabsEnabled = true;
  let tabs: Tab[] = [];
  const closed: string[] = [];
  const navigated: string[] = [];
  const selections: Selection[] = [];
  const picks: ((selection: Selection) => unknown)[] = [];
  const ctx = {
    client: {
      rpc: (definition: { id: string }) => definition.id === "workflows" ? {
        snapshot: async ({ ownerID }: { ownerID: string }) => {
          counts.workflowSnapshots++;
          return { runs: (await store.list(ownerID)).map(workflowSummary) };
        },
        inspect: async ({ runID }: { runID: string }) => {
          counts.inspections++;
          const run = await store.get(runID);
          inspected.push(run);
          return run;
        },
      } : {
        snapshot: async ({ coordinatorIDs }: { coordinatorIDs: string[] }, options?: { signal?: AbortSignal }) => {
          counts.workerSnapshots++;
          if (holdWorkers) {
            const abort = holdWorkers;
            await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(abort()), { once: true }));
          }
          await delay;
          if (workerFailure !== undefined) throw workerFailure;
          return { workers: workers.filter((worker) => coordinatorIDs.includes(worker.coordinatorID)) };
        },
        restore: async () => ({ workers: [] }),
      },
      session: {
        list: async () => ({ data: [] }),
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID, title: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 }, metadata: {},
        }),
      },
    },
    storage: { store: <T>(_key: string, { initial }: { initial: T }) => {
      const value = structuredClone(initial);
      return [value, async (update: (draft: T) => void) => update(value)];
    } },
    data: {
      location: { default: () => ({ directory: "/fixture" }) },
      session: { get: () => undefined, status: () => "idle", permission: { list: () => [] }, form: { list: () => [] } },
      listen: (listener: typeof listeners extends Set<infer T> ? T : never) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    ui: {
      router: {
        current: () => ({ type: "session", sessionID: owner }),
        navigate: (route: { sessionID: string }) => { navigated.push(route.sessionID); },
      },
      panel: { current: () => panel, open: (name: string) => { panel = { name, sessionID: owner }; } },
      tabs: {
        enabled: () => tabsEnabled,
        list: () => tabs,
        close: (id: string) => {
          closed.push(id);
          tabs = tabs.filter((tab) => tab.sessionID !== id);
          return true;
        },
        focus: (id: string) => {
          tabs = [...tabs.filter((tab) => tab.sessionID !== id), { sessionID: id, title: id, active: true, busy: false, attention: false }];
          return true;
        },
      },
      slot: ({ append, render }: { append: string; render: () => unknown }) => { if (append === "app") slots.push(render); return () => {}; },
      dialog: {
        select: async (selection: Selection) => {
          if (selection.title === "Dynamic workflows") return savedRuns ? `run-${owner === "A" ? 0 : 1}` : undefined;
          selections.push(selection);
          return picks.shift()?.(selection);
        },
        show: () => {},
        set: () => {},
      },
      toast: { show: (toast: { variant: string }) => { if (toast.variant === "error") errors.push(toast); } },
    },
    keymap: { layer: (build: () => { commands: { id: string; run: () => unknown }[] }) => {
      for (const command of build().commands) commands.set(command.id, command.run);
    } },
  };
  const dispose = await plugin.setup(ctx as unknown as Plugin.Context);
  for (const render of slots) render();
  await settle();
  return {
    counts, errors, store, inspected, closed, navigated, selections,
    event: (type: string) => { for (const listener of listeners) listener({ details: { type, data: { sessionID: owner } } }); },
    owner: (id: string) => { owner = id; },
    panel: (name?: string) => { panel = name ? { name, sessionID: owner } : undefined; },
    command: (id: string) => commands.get(id)?.(),
    failWorkerSnapshots: (error?: unknown) => { workerFailure = error; },
    holdWorkerSnapshots: (abortError?: () => unknown) => { holdWorkers = abortError; },
    workers: (values: Worker[]) => { workers = values; },
    tabs: (values: Partial<Tab>[], enabled = true) => {
      tabsEnabled = enabled;
      tabs = values.map((tab) => ({ sessionID: "", title: tab.sessionID ?? "", active: false, busy: false, attention: false, ...tab }));
    },
    pick: (...values: ((selection: Selection) => unknown)[]) => { picks.push(...values); },
    // Holds worker snapshots until the returned function releases them.
    delayWorkerSnapshots: () => {
      let release!: () => void;
      delay = new Promise((resolve) => { release = resolve; });
      return () => { delay = undefined; release(); };
    },
    dispose: () => { if (typeof dispose === "function") dispose(); },
  };
}
