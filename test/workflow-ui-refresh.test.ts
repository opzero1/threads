import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { workflowUI } from "../src/workflow-ui";
import type { WorkflowSummary } from "../src/workflow-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// An event-loop barrier drains RPC continuations, without sleeping or advancing the polling timer.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function summary(id: string): WorkflowSummary {
  return {
    version: 1, id, key: id, ownerID: id, model: { providerID: "test", id: "test" },
    projectID: "test", directory: "/test", name: id, description: "", status: "running",
    limits: { concurrency: 1, maxAgents: 1, agentTimeoutMs: 1000, timeoutMs: 1000 },
    created: 0, updated: 0, phase: "", counts: { completed: 0, running: 1, queued: 0, failed: 0, total: 1 },
    usage: { tokens: 0, cost: 0, measured: false },
  };
}

function harness() {
  let owner = "A";
  let listener!: (event: { details: { type: string } }) => void;
  let choose!: () => Promise<void>;
  let renderApp: (() => unknown) | undefined;
  const calls: { ownerID: string; reply: ReturnType<typeof deferred<{ runs: WorkflowSummary[] }>>; signal: AbortSignal }[] = [];
  const selections: { options: { value: string }[] }[] = [];
  const toasts: unknown[] = [];
  // Only host boundaries are substituted; refresh, owner fencing, signals and picker code are real.
  const ctx = {
    client: { rpc: () => ({ snapshot: ({ ownerID }: { ownerID: string }, { signal }: { signal: AbortSignal }) => {
      const reply = deferred<{ runs: WorkflowSummary[] }>();
      calls.push({ ownerID, reply, signal });
      return reply.promise;
    } }) },
    data: {
      session: { get: () => undefined }, location: { default: () => ({}) },
      listen: (callback: typeof listener) => { listener = callback; return () => {}; },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: owner }) },
      panel: { current: () => undefined },
      slot: (slot: { append: string; render: () => unknown }) => {
        if (slot.append === "app") renderApp = slot.render;
        return () => {};
      },
      dialog: { select: async (input: typeof selections[number]) => { selections.push(input); return undefined; } },
      toast: { show: (input: unknown) => toasts.push(input) },
    },
    keymap: { layer: (commands: () => { commands: { run: typeof choose }[] }) => { choose = commands().commands[0]!.run; } },
  };
  const ui = workflowUI(ctx as unknown as Plugin.Context, RGBA.fromHex("#ffffff"));
  renderApp?.();
  return {
    ui, calls, selections, toasts, choose: () => choose(),
    owner: (value: string) => { owner = value; },
    event: () => listener({ details: { type: "rpc.workflows.updated" } }),
  };
}

test("owner B is fetched after stale A settles, without a third event or an open panel", async () => {
  const h = harness();
  try {
    h.event();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A"]);
    h.owner("B");
    h.event();
    expect(h.ui.active()).toBe(0);
    h.calls[0]!.reply.resolve({ runs: [summary("A")] });
    await settle();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A", "B"]);
    expect(h.ui.active()).toBe(0);
    h.calls[1]!.reply.resolve({ runs: [summary("B")] });
    await settle();
    expect(h.ui.active()).toBe(1);
    expect(h.calls).toHaveLength(2);
  } finally { h.ui.dispose(); }
});

test("same-owner events coalesce into one successor, not a refresh loop", async () => {
  const h = harness();
  try {
    h.event();
    h.event();
    h.event();
    h.calls[0]!.reply.resolve({ runs: [] });
    await settle();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A", "A"]);
    h.calls[1]!.reply.resolve({ runs: [summary("A")] });
    await settle();
    expect(h.ui.active()).toBe(1);
    expect(h.calls).toHaveLength(2);
  } finally { h.ui.dispose(); }
});

test("disposal suppresses queued refresh and late results", async () => {
  const h = harness();
  h.event();
  h.owner("B");
  h.event();
  h.ui.dispose();
  expect(h.calls[0]!.signal.aborted).toBe(true);
  h.calls[0]!.reply.resolve({ runs: [summary("A")] });
  await settle();
  h.event();
  expect(h.calls).toHaveLength(1);
  expect(h.ui.active()).toBe(0);
});

test("a rejected stale RPC still drains the queued owner refresh", async () => {
  const h = harness();
  try {
    h.event();
    h.owner("B");
    h.event();
    h.calls[0]!.reply.reject(new Error("A disconnected"));
    await settle();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A", "B"]);
    h.calls[1]!.reply.resolve({ runs: [summary("B")] });
    await settle();
    expect(h.ui.active()).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.toasts).toHaveLength(0);
  } finally { h.ui.dispose(); }
});

test("picker waits for in-flight and queued refreshes, then requests its own fresh snapshot", async () => {
  const h = harness();
  try {
    h.event();
    h.owner("B");
    h.event();
    const choosing = h.choose();
    expect(h.selections).toHaveLength(0);
    h.calls[0]!.reply.resolve({ runs: [summary("A")] });
    await settle();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A", "B"]);
    expect(h.selections).toHaveLength(0);
    h.calls[1]!.reply.resolve({ runs: [summary("old-B")] });
    await settle();
    expect(h.calls.map((call) => call.ownerID)).toEqual(["A", "B", "B"]);
    expect(h.selections).toHaveLength(0);
    h.calls[2]!.reply.resolve({ runs: [summary("fresh-B")] });
    await choosing;
    expect(h.selections[0]!.options.map((option) => option.value)).toEqual(["fresh-B"]);
    expect(h.toasts).toHaveLength(0);
    expect(h.calls).toHaveLength(3);
  } finally { h.ui.dispose(); }
});
