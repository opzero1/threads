import { describe, expect, test } from "bun:test";
import {
  activityGroups,
  activityThreads,
  activitySubtitle,
  activityTime,
  cleanRoleTitle,
  dateGroup,
  type ActivityItem,
} from "../src/activity-model";

const now = new Date(2026, 8, 20, 0, 1);
test("subtitles lead with compact project identity and only append known roles", () => {
  const directory = "/Users/fixture/workspaces/personal/op-threads";
  expect(activitySubtitle({ directory })).toBe("op-threads");
  expect(
    activitySubtitle({ directory, project: { canonical: directory } }),
  ).toBe("op-threads");
  expect(
    activitySubtitle({
      directory,
      project: { canonical: directory, name: "Threads" },
      role: "Main",
    }),
  ).toBe("Threads · Main");
  expect(
    activitySubtitle({
      directory: "/Users/fixture/worktrees/sidebar",
      project: { canonical: directory },
      role: "Worker",
    }),
  ).toBe("op-threads · Worker · sidebar");
  expect(activitySubtitle({ directory: "C:\\workspaces\\op-threads\\" })).toBe(
    "op-threads",
  );
});
test("long worktree names keep known roles in the leading visible subtitle", () => {
  const input = {
    directory:
      "/Users/fixture/worktrees/direct.feature-gating-outage-20260915",
    project: { canonical: "/Users/fixture/workspaces/direct" },
  };
  const subtitle = activitySubtitle({ ...input, role: "Worker" });
  expect(subtitle).toBe(
    "direct · Worker · direct.feature-gating-outage-20260915",
  );
  expect(subtitle.slice(0, 24)).toContain("direct · Worker");
  expect(activitySubtitle(input)).toBe(
    "direct · direct.feature-gating-outage-20260915",
  );
});
function item(id: string, values: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    title: id,
    subtitle: "Main · project",
    updated: now.getTime(),
    active: false,
    attention: false,
    busy: false,
    pinned: false,
    hidden: false,
    open: false,
    ...values,
  };
}

describe("Activity grouping", () => {
  test("attention precedes running, then unread errors/results; pin cannot outrank activity", () => {
    const groups = activityGroups(
      [
        item("pinned", { pinned: true }),
        item("idle"),
        item("result", { unread: "activity" }),
        item("running", { busy: true }),
        item("attention", { attention: true, pinned: true }),
      ],
      now,
    );
    expect([...groups.keys()]).toEqual(["Priority", "Pinned", "Today"]);
    expect(groups.get("Priority")?.map((row) => row.id)).toEqual([
      "attention",
      "running",
      "result",
    ]);
    expect(
      [...groups.values()].flat().filter((row) => row.id === "attention"),
    ).toHaveLength(1);
    expect(activityGroups([item("idle")], now).has("Priority")).toBe(false);
  });
  test("selection does not change ordering; equal timestamps have a stable tie breaker", () => {
    const ids = (active: boolean) =>
      [...activityGroups([item("z", { active }), item("a")], now).values()]
        .flat()
        .map((row) => row.id);
    expect(ids(false)).toEqual(["a", "z"]);
    expect(ids(true)).toEqual(ids(false));
  });
  test("hidden workers do not return through pin/history; active, open and attention remain visible", () => {
    const groups = activityGroups(
      [
        item("hidden", { hidden: true, pinned: true }),
        item("open", { hidden: true, open: true }),
        item("busy", { hidden: true, busy: true }),
        item("attention", { hidden: true, attention: true }),
        item("selected", { hidden: true, active: true }),
      ],
      now,
    );
    expect(
      [...groups.values()]
        .flat()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["attention", "busy", "open", "selected"]);
  });
  test("local calendar boundaries are not elapsed 24-hour buckets", () => {
    expect(dateGroup(new Date(2026, 8, 19, 23, 59).getTime(), now)).toBe(
      "Yesterday",
    );
    expect(dateGroup(new Date(2026, 8, 20, 0, 0).getTime(), now)).toBe("Today");
    const weekday = new Date(2026, 8, 18, 12);
    expect(dateGroup(weekday.getTime(), now)).toBe(
      weekday.toLocaleDateString(undefined, { weekday: "long" }),
    );
    expect(
      dateGroup(new Date(2025, 11, 31, 23).getTime(), new Date(2026, 0, 1, 1)),
    ).toBe("Yesterday");
    expect(
      dateGroup(new Date(2026, 2, 8, 23).getTime(), new Date(2026, 2, 9, 1)),
    ).toBe("Yesterday");
  });
  test("title cleanup timestamp does not pull an older executed conversation into Today", () => {
    const idle = new Date(2026, 8, 19, 15).getTime();
    const updated = activityTime({
      created: idle - 1000,
      idle,
      updated: now.getTime(),
    });
    expect([
      ...activityGroups([item("renamed", { updated })], now).keys(),
    ]).toEqual(["Yesterday"]);
    expect(activityTime({ created: 1, updated: 2 })).toBe(2);
  });
});

describe("managed worker stacks", () => {
  test("a worker needing input lifts its main and siblings into Priority without duplicates", () => {
    const main = item("main", { updated: now.getTime() - 86400000 });
    const groups = activityThreads(
      [
        main,
        item("other", { busy: true }),
        item("busy", { coordinatorID: "main", busy: true }),
        item("input", { coordinatorID: "main", attention: true }),
        item("idle", { coordinatorID: "main", pinned: true }),
      ],
      now,
    );
    const threads = [...groups.values()].flat();
    expect([...groups.keys()]).toEqual(["Priority"]);
    expect(threads.map((thread) => thread.item.id)).toEqual(["main", "other"]);
    expect(threads[0]?.children.map((child) => child.id)).toEqual([
      "input", "busy", "idle",
    ]);
    expect(threads[0]?.status).toEqual({
      attention: true,
      busy: true,
      unread: undefined,
    });
    expect(threads[0]?.item).toBe(main);
    expect(
      threads.flatMap((thread) => [thread.item, ...thread.children]),
    ).toHaveLength(5);
  });
  test("visible worker pins and activity timestamps determine the stack's section", () => {
    const main = item("main", { updated: now.getTime() - 86400000 });
    const section = (worker: ActivityItem) => [
      ...activityThreads([main, worker], now).keys(),
    ];
    expect(section(item("child", { coordinatorID: "main", pinned: true })))
      .toEqual(["Pinned"]);
    expect(section(item("child", { coordinatorID: "main" })))
      .toEqual(["Today"]);
    expect(section(item("child", {
      coordinatorID: "main", hidden: true, pinned: true,
    }))).toEqual(["Yesterday"]);
  });
  test("missing, hidden or invalid parents leave workers reachable as standalone rows", () => {
    const threads = [
      ...activityThreads(
        [
          item("hidden", { hidden: true }),
          item("child", { coordinatorID: "hidden", attention: true }),
          item("orphan", { coordinatorID: "absent" }),
          item("self", { coordinatorID: "self" }),
          item("cycle-a", { coordinatorID: "cycle-b" }),
          item("cycle-b", { coordinatorID: "cycle-a" }),
        ],
        now,
      ).values(),
    ].flat();
    expect(threads.map((thread) => thread.item.id).sort()).toEqual([
      "child", "cycle-a", "cycle-b", "orphan", "self",
    ]);
    expect(threads.every((thread) => thread.children.length === 0)).toBe(true);
  });
  test("collapsed summaries retain unread errors without changing the main session's own status", () => {
    const main = item("main", { unread: "activity" });
    const threads = activityThreads(
      [main, item("worker", { coordinatorID: "main", unread: "error" })],
      now,
    );
    expect(threads.get("Priority")?.[0]?.status.unread).toBe("error");
    expect(main.unread).toBe("activity");
  });
});

test("legacy cleanup requires managed identity, strips exactly once and retains the remainder", () => {
  expect(cleanRoleTitle("[Main] Ordinary", false)).toBe("[Main] Ordinary");
  expect(cleanRoleTitle("[Worker] Review auth", true)).toBe("Review auth");
  expect(cleanRoleTitle("[Main] [Worker] User remainder", true)).toBe(
    "[Worker] User remainder",
  );
  expect(cleanRoleTitle("[Main]  Keep spaces ", true)).toBe(" Keep spaces ");
  expect(cleanRoleTitle("[Main] ", true)).toBe("[Main] ");
  expect(cleanRoleTitle("A renamed worker", true)).toBe("A renamed worker");
});
