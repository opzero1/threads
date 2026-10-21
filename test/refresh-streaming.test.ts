import { expect, test } from "bun:test";
import { refreshHarness, settle, streams, worker } from "./support/refresh-harness";

test("production terminal callbacks ignore streamed content with closed and open panels", async () => {
  const h = await refreshHarness(120);
  try {
    for (const panel of [undefined, "threads.workflows"]) {
      h.panel(panel);
      const before = { ...h.counts };
      for (const type of streams) for (let index = 0; index < 100; index++) {
        h.event(type);
        await settle();
      }
      expect(h.counts).toEqual(before);
    }
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});

test("lifecycle and attention events still refresh both production snapshot paths", async () => {
  const h = await refreshHarness();
  try {
    for (const type of ["session.created", "session.metadata.updated", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.status", "session.idle", "session.deleted", "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"]) {
      const before = { ...h.counts };
      h.event(type);
      await settle();
      expect(h.counts.workflowSnapshots).toBe(before.workflowSnapshots + 1);
      expect(h.counts.workerSnapshots).toBe(before.workerSnapshots + 1);
    }
  } finally { h.dispose(); }
});

test("commands and workflow RPC updates remain fresh after owner switching", async () => {
  const h = await refreshHarness(4);
  try {
    await h.command("workflows.open");
    expect(h.counts.inspections).toBe(1);
    h.owner("B");
    const before = h.counts.workflowSnapshots;
    h.event("rpc.workflows.updated");
    await settle();
    expect(h.counts.workflowSnapshots).toBe(before + 1);
    await h.command("workflows.open");
    expect(h.counts.inspections).toBe(2);
    await h.command("threads.reopen");
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});

test("open result panels poll journal-only changes; unrelated panels do not poll finished runs", async () => {
  const h = await refreshHarness(1);
  try {
    await h.store.update("run-0", (run) => { run.status = "completed"; run.result = "original"; });
    await h.command("workflows.open");
    const before = h.counts.inspections;
    await h.store.update("run-0", (run) => { run.result = "external update"; });
    await Bun.sleep(3100);
    expect(h.counts.inspections).toBeGreaterThan(before);
    expect(h.inspected.at(-1)?.result).toBe("external update");
    h.panel("another-plugin");
    const closed = { ...h.counts };
    await Bun.sleep(3100);
    expect(h.counts.workflowSnapshots).toBe(closed.workflowSnapshots);
    expect(h.counts.inspections).toBe(closed.inspections);
    h.event("rpc.workflows.updated");
    await settle();
    expect(h.counts.workflowSnapshots).toBe(closed.workflowSnapshots + 1);
    expect(h.counts.inspections).toBe(closed.inspections);
  } finally { h.dispose(); }
}, 10000);

test("one owner coalesces events during a delayed snapshot and reconciles tabs from the committed result", async () => {
  const h = await refreshHarness();
  try {
    h.workers([worker("hidden", { hidden: true }), worker("visible")]);
    h.tabs([{ sessionID: "hidden" }]);
    const release = h.delayWorkerSnapshots();
    const before = h.counts.workerSnapshots;
    h.event("session.status");
    await settle();
    for (const type of ["session.idle", "permission.asked", "session.status"]) h.event(type);
    await settle();
    expect(h.counts.workerSnapshots).toBe(before + 1);
    expect(h.closed).toEqual([]);
    release();
    for (let hop = 0; hop < 5; hop++) await settle();
    expect(h.counts.workerSnapshots).toBe(before + 2);
    expect(h.closed).toEqual(["hidden"]);
    h.pick(() => undefined);
    await h.command("threads.activity.choose");
    expect(h.selections.at(-1)?.options.map((option) => [option.value, option.description])).toEqual([
      ["A", "Main"],
      ["visible", "Finished · starting"],
    ]);
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});

test("with tabs disabled the list still refreshes, closes no tab, and opens a worker by route", async () => {
  const h = await refreshHarness();
  try {
    h.workers([worker("hidden", { hidden: true }), worker("visible", { report: { verdict: "FAIL", summary: "failed", evidence: [] } })]);
    h.tabs([{ sessionID: "hidden" }], false);
    const before = h.counts.workerSnapshots;
    h.event("session.status");
    for (let hop = 0; hop < 3; hop++) await settle();
    expect(h.counts.workerSnapshots).toBe(before + 1);
    h.pick((selection) => selection.options.find((option) => option.value === "visible")?.value, () => "open");
    await h.command("threads.activity.choose");
    expect(h.selections.at(-1)?.options.map((option) => option.title)).toEqual(["Open", "Dismiss"]);
    expect(h.navigated).toEqual(["visible"]);
    expect(h.closed).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});

test("the worker menu dismisses and restores, and does nothing once the row is gone", async () => {
  const h = await refreshHarness();
  const descriptions = () => h.selections.at(-1)?.options.map((option) => option.description);
  try {
    h.workers([worker("visible")]);
    h.event("session.status");
    for (let hop = 0; hop < 3; hop++) await settle();
    h.pick(() => "visible", () => "dismiss", () => undefined);
    await h.command("threads.activity.choose");
    await h.command("threads.activity.choose");
    expect(descriptions()).toEqual(["Main", "Closed · starting"]);
    h.pick(() => "visible", (menu) => menu.options[1]?.title === "Restore" && "dismiss", () => undefined);
    await h.command("threads.activity.choose");
    await h.command("threads.activity.choose");
    expect(descriptions()).toEqual(["Main", "Finished · starting"]);
    h.tabs([], false);
    h.pick(() => "visible", async () => {
      h.workers([]);
      h.event("session.status");
      for (let hop = 0; hop < 3; hop++) await settle();
      return "open";
    });
    await h.command("threads.activity.choose");
    expect(h.navigated).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});
