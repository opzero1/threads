import { describe, expect, test } from "bun:test";
import {
  activityList,
  footerSummary,
  footerText,
  listCategory,
  reportedTabAction,
  threadsOptions,
  workerState,
  type ListItem,
} from "../src/activity-model";

function row(id: string, values: Partial<ListItem> = {}): ListItem {
  return {
    id,
    title: id,
    subtitle: "project",
    updated: 1000,
    active: false,
    attention: false,
    busy: false,
    pinned: false,
    hidden: false,
    open: false,
    closed: false,
    worker: false,
    ...values,
  };
}

describe("terminal options", () => {
  test("the footer and on-demand worker tabs are the defaults", () => {
    expect(threadsOptions({})).toEqual({ activity: "footer", workerTabs: "manual" });
    expect(threadsOptions({ activity: "footer", workerTabs: "manual" })).toEqual({
      activity: "footer",
      workerTabs: "manual",
    });
  });

  test("the sidebar and automatic worker tabs stay available as options", () => {
    expect(threadsOptions({ activity: "sidebar" }).activity).toBe("sidebar");
    expect(threadsOptions({ workerTabs: "auto" }).workerTabs).toBe("auto");
  });

  test("legacy booleans keep their meaning: true shows the sidebar, false hides it", () => {
    expect(threadsOptions({ activity: true }).activity).toBe("sidebar");
    expect(threadsOptions({ activity: false }).activity).toBe("footer");
    expect(threadsOptions({ activity: "unknown", workerTabs: true }).workerTabs).toBe("manual");
  });
});

describe("footer indicator", () => {
  test("an idle TUI renders nothing", () => {
    const text = footerText(footerSummary([], 0));
    expect(text.visible).toBe(false);
    expect(text.spinning).toBe(false);
    expect(footerText(footerSummary([{ busy: false, attention: false }], 0)).visible).toBe(false);
  });

  test("running workers and workflows spin with counts", () => {
    const summary = footerSummary(
      [{ busy: true, attention: false }, { busy: true, attention: false }, { busy: false, attention: false }],
      1,
    );
    expect(summary).toEqual({ running: 2, attention: 0, workflows: 1 });
    expect(footerText(summary)).toEqual({
      visible: true,
      spinning: true,
      label: "2 workers · 1 workflow",
      attention: "",
    });
    expect(footerText({ running: 1, attention: 0, workflows: 0 }).label).toBe("1 worker");
    expect(footerText({ running: 0, attention: 0, workflows: 2 }).label).toBe("2 workflows");
  });

  test("a worker waiting for input is marked once, not also counted as running", () => {
    const summary = footerSummary(
      [{ busy: true, attention: true }, { busy: true, attention: false }],
      0,
    );
    expect(summary).toEqual({ running: 1, attention: 1, workflows: 0 });
    expect(footerText(summary).attention).toBe("? 1 needs input");
    const waiting = footerText(footerSummary([{ busy: false, attention: true }], 0));
    expect(waiting).toEqual({ visible: true, spinning: false, label: "", attention: "? 1 needs input" });
  });
});

describe("worker list", () => {
  test("rows group as needs attention, running, pinned, finished workers, recent sessions and closed", () => {
    const groups = activityList([
      row("recent"),
      row("finished", { worker: true }),
      row("pinned", { pinned: true }),
      row("running", { busy: true, worker: true }),
      row("attention", { attention: true, busy: true, worker: true }),
      row("closed", { closed: true, busy: true }),
    ]);
    expect(groups.map(([category, items]) => [category, items.map((item) => item.id)])).toEqual([
      ["Needs attention", ["attention"]],
      ["Running", ["running"]],
      ["Pinned", ["pinned"]],
      ["Finished", ["finished"]],
      ["Recent", ["recent"]],
      ["Closed", ["closed"]],
    ]);
  });

  test("hidden workers stay out unless open, selected, running or waiting; closed rows stay reachable", () => {
    const ids = activityList([
      row("hidden", { worker: true, hidden: true, pinned: true }),
      row("open", { worker: true, hidden: true, open: true }),
      row("selected", { worker: true, hidden: true, active: true }),
      row("busy", { worker: true, hidden: true, busy: true }),
      row("closed", { worker: true, closed: true }),
    ]).flatMap(([, items]) => items.map((item) => item.id));
    expect(ids.sort()).toEqual(["busy", "closed", "open", "selected"]);
  });

  test("rows within a group follow recency with a stable tie breaker", () => {
    const [[, items]] = activityList([
      row("b", { updated: 5 }),
      row("a", { updated: 5 }),
      row("new", { updated: 9 }),
      row("unknown", { updated: 0 }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["new", "a", "b", "unknown"]);
    expect(listCategory(row("x", { pinned: true, worker: true }))).toBe("Pinned");
  });

  test("worker rows describe input, running, verdict and native outcome", () => {
    const report = { verdict: "FAIL" };
    expect(workerState({ outcome: null, report: null }, true, true)).toBe("needs input");
    expect(workerState({ outcome: "succeeded", report }, true, false)).toBe("running");
    expect(workerState({ outcome: "succeeded", report }, false, false)).toBe("FAIL");
    expect(workerState({ outcome: null, report: null }, false, false)).toBe("starting");
    expect(workerState({ outcome: "succeeded", report: null }, false, false)).toBe("no report");
    expect(workerState({ outcome: "interrupted", report: null }, false, false)).toBe("interrupted");
    expect(workerState({ outcome: "failed", report: null }, false, false)).toBe("failed");
  });
});

describe("worker tabs opened from the list", () => {
  const tab = (values: Partial<{ active: boolean; busy: boolean; attention: boolean }> = {}) => ({
    active: false,
    busy: false,
    attention: false,
    ...values,
  });
  const report = { verdict: "PASS" };

  test("stay open until the worker reports", () => {
    expect(reportedTabAction({ report: null }, "idle", tab())).toBe("keep");
    expect(reportedTabAction({ report }, "running", tab())).toBe("keep");
  });

  test("close once reported, idle and not focused, busy or waiting", () => {
    expect(reportedTabAction({ report }, "idle", tab())).toBe("close");
    expect(reportedTabAction({ report }, "idle", tab({ active: true }))).toBe("keep");
    expect(reportedTabAction({ report }, "idle", tab({ busy: true }))).toBe("keep");
    expect(reportedTabAction({ report }, "idle", tab({ attention: true }))).toBe("keep");
  });

  test("are forgotten when the user already closed them", () => {
    expect(reportedTabAction({ report }, "idle", undefined)).toBe("forget");
    expect(reportedTabAction({ report: null }, "idle", undefined)).toBe("keep");
  });
});
