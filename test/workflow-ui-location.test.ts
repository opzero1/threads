import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { workflowUI } from "../src/workflow-ui";
import { workflowSummary, type WorkflowRun } from "../src/workflow-types";

test("UI reads recover from missing Location, but workflow control and save never reroute", async () => {
  const focused = { directory: "/gone" };
  const fallback = { directory: "/live" };
  const run: WorkflowRun = {
    version: 1, id: "run", key: "run", ownerID: "owner", model: { providerID: "fixture", id: "fixture" },
    projectID: "fixture", directory: "/gone", name: "fixture", description: "", status: "running",
    limits: { concurrency: 1, maxAgents: null, agentTimeoutMs: null, timeoutMs: null },
    created: 0, updated: 0, phase: "", callerAgent: "build", args: null,
    fingerprint: "fixture", deliveryID: "fixture", delivered: false,
    steps: [], checkpoints: [], logs: [], script: "return true",
  };
  const calls: { method: string; directory: string }[] = [];
  const missing = { _tag: "LocationNotFoundError", location: focused };
  const slots = new Map<string, (panel?: unknown) => unknown>();
  const commands = new Map<string, () => unknown>();
  const toasts: { variant: string }[] = [];
  let panelRender = false;
  const stopRender = Symbol("host render boundary");
  const request = async (method: string, options: { location: typeof focused }) => {
    calls.push({ method, directory: options.location.directory });
    if (options.location.directory === focused.directory) throw missing;
    return run;
  };
  const ctx = {
    location: focused,
    client: { rpc: () => ({
      snapshot: async (_input: unknown, options: { location: typeof focused }) => { await request("snapshot", options); return { runs: [workflowSummary(run)] }; },
      inspect: (_input: unknown, options: { location: typeof focused }) => request("inspect", options),
      control: (_input: unknown, options: { location: typeof focused }) => request("control", options),
      save: (_input: unknown, options: { location: typeof focused }) => request("save", options),
    }) },
    data: { session: { get: () => undefined }, location: { default: () => fallback }, listen: () => () => {} },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "owner" }) },
      panel: { open: () => {}, current: () => undefined },
      slot: ({ append, render }: { append: string; render: (panel?: unknown) => unknown }) => { slots.set(append, render); return () => {}; },
      dialog: { select: async ({ title }: { title: string }) => title === "Save location" ? "project" : "run", prompt: async () => "saved" },
      toast: { show: (value: { variant: string }) => toasts.push(value) },
    },
    keymap: { layer: (build: () => { commands: { id: string; run: () => unknown }[] }) => {
      for (const command of build().commands) commands.set(command.id, command.run);
      if (panelRender) throw stopRender;
    } },
  };
  const ui = workflowUI(ctx as unknown as Plugin.Context, RGBA.fromHex("#ffffff"));
  try {
    slots.get("app")?.();
    await commands.get("workflows.open")?.();
    expect(calls).toEqual([
      { method: "snapshot", directory: "/gone" }, { method: "snapshot", directory: "/live" },
      { method: "inspect", directory: "/gone" }, { method: "inspect", directory: "/live" },
    ]);
    panelRender = true;
    try { slots.get("session.panel")?.({ name: "threads.workflows", close: () => {}, toggleFullscreen: () => {} }); }
    catch (cause) { if (cause !== stopRender) throw cause; }
    await commands.get("workflows.pause")?.();
    await commands.get("workflows.save")?.();
    expect(calls.slice(4)).toEqual([{ method: "control", directory: "/gone" }, { method: "save", directory: "/gone" }]);
    expect(toasts.map((toast) => toast.variant)).toEqual(["error", "error"]);
  } finally { ui.dispose(); }
});
