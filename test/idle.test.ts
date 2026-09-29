import { describe, expect, test } from "bun:test";
import { workInProgress, workflowProgressing } from "../src/idle";

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
