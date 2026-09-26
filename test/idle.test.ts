import { describe, expect, test } from "bun:test";
import { workInProgress, workerWorking, workflowProgressing } from "../src/idle";

const report = (verdict: "PASS" | "FAIL" | "INCONCLUSIVE") => ({
  verdict,
  summary: "fixture",
  evidence: [],
});

describe("automatic managed-worker tabs", () => {
  test("a running worker gets a tab whatever its last outcome or report", () => {
    expect(workerWorking({ outcome: null, report: null }, "running")).toBe(true);
    expect(workerWorking({ outcome: "succeeded", report: null }, "running")).toBe(true);
    expect(workerWorking({ outcome: "failed", report: report("FAIL") }, "running")).toBe(true);
  });

  test("a freshly spawned worker gets a tab before its first execution starts", () => {
    expect(workerWorking({ outcome: null, report: null }, "idle")).toBe(true);
  });

  test("finished idle workers are never opened automatically", () => {
    expect(workerWorking({ outcome: "succeeded", report: null }, "idle")).toBe(false);
    expect(workerWorking({ outcome: "succeeded", report: report("FAIL") }, "idle")).toBe(false);
    expect(workerWorking({ outcome: "succeeded", report: report("INCONCLUSIVE") }, "idle")).toBe(false);
    expect(workerWorking({ outcome: "failed", report: null }, "idle")).toBe(false);
    expect(workerWorking({ outcome: "interrupted", report: null }, "idle")).toBe(false);
  });

  test("a report without a recorded outcome still counts as finished", () => {
    expect(workerWorking({ outcome: null, report: report("FAIL") }, "idle")).toBe(false);
  });
});

describe("background refresh timers", () => {
  const idle = () => "idle" as const;
  const tab = (busy = false, attention = false) => ({ busy, attention });

  test("an idle TUI sends no timer-driven requests", () => {
    expect(workInProgress([], [], idle)).toBe(false);
    expect(workInProgress([tab(), tab()], ["ses_a", "ses_b"], idle)).toBe(false);
  });

  test("busy or attention tabs keep the timer active", () => {
    expect(workInProgress([tab(), tab(true)], [], idle)).toBe(true);
    expect(workInProgress([tab(false, true)], [], idle)).toBe(true);
  });

  test("a running worker without an open tab keeps the timer active", () => {
    const status = (id: string) => (id === "ses_worker" ? "running" : "idle") as "idle" | "running";
    expect(workInProgress([tab()], new Set(["ses_other", "ses_worker"]).keys(), status)).toBe(true);
    expect(workInProgress([tab()], ["ses_other"], status)).toBe(false);
  });

  test("status lookups stop at the first running session", () => {
    const seen: string[] = [];
    const status = (id: string) => {
      seen.push(id);
      return (id === "ses_b" ? "running" : "idle") as "idle" | "running";
    };
    expect(workInProgress([], ["ses_a", "ses_b", "ses_c"], status)).toBe(true);
    expect(seen).toEqual(["ses_a", "ses_b"]);
  });

  test("only runs that can still progress keep the workflow panel polling", () => {
    expect(workflowProgressing([])).toBe(false);
    expect(workflowProgressing(["completed", "failed", "stopped", "paused", "interrupted"])).toBe(false);
    for (const status of ["running", "pausing", "waiting"])
      expect(workflowProgressing(["completed", status])).toBe(true);
  });
});
