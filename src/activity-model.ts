export type ActivityItem = {
  id: string;
  title: string;
  subtitle: string;
  updated: number;
  active: boolean;
  attention: boolean;
  busy: boolean;
  unread?: "activity" | "error";
  pinned: boolean;
  hidden: boolean;
  open: boolean;
  coordinatorID?: string;
};

export type ActivityThread = {
  item: ActivityItem;
  children: ActivityItem[];
  status: Pick<ActivityItem, "attention" | "busy" | "unread">;
};

export type ActivityMode = "footer" | "sidebar";
export type WorkerTabs = "manual" | "auto";

// `activity: true` and `false` predate the footer; they keep meaning "sidebar" and "no sidebar".
export function threadsOptions(options: Readonly<Record<string, unknown>>) {
  const activity: ActivityMode =
    options.activity === "sidebar" || options.activity === true
      ? "sidebar"
      : "footer";
  const workerTabs: WorkerTabs = options.workerTabs === "auto" ? "auto" : "manual";
  return { activity, workerTabs };
}

export type ListCategory =
  | "Needs attention"
  | "Running"
  | "Pinned"
  | "Finished"
  | "Recent"
  | "Closed";
const listOrder: ListCategory[] = [
  "Needs attention",
  "Running",
  "Pinned",
  "Finished",
  "Recent",
  "Closed",
];
export type ListItem = ActivityItem & { closed: boolean; worker: boolean };

export function listCategory(item: ListItem): ListCategory {
  if (item.closed) return "Closed";
  if (item.attention) return "Needs attention";
  if (item.busy) return "Running";
  if (item.pinned) return "Pinned";
  return item.worker ? "Finished" : "Recent";
}

export function workerState(
  worker: {
    outcome: "succeeded" | "failed" | "interrupted" | null;
    report: { verdict: string } | null;
  },
  busy: boolean,
  attention: boolean,
) {
  if (attention) return "needs input";
  if (busy) return "running";
  if (worker.report) return worker.report.verdict;
  if (worker.outcome === null) return "starting";
  return worker.outcome === "succeeded" ? "no report" : worker.outcome;
}

export type FooterSummary = {
  running: number;
  attention: number;
  workflows: number;
};

export function footerSummary(
  workers: Iterable<{ busy: boolean; attention: boolean }>,
  workflows: number,
): FooterSummary {
  let running = 0;
  let attention = 0;
  for (const worker of workers) {
    if (worker.attention) attention++;
    else if (worker.busy) running++;
  }
  return { running, attention, workflows };
}

export function footerText(summary: FooterSummary) {
  const count = (value: number, noun: string) =>
    `${value} ${noun}${value === 1 ? "" : "s"}`;
  const label = [
    ...(summary.running ? [count(summary.running, "worker")] : []),
    ...(summary.workflows ? [count(summary.workflows, "workflow")] : []),
  ].join(" · ");
  return {
    visible: summary.running + summary.workflows + summary.attention > 0,
    spinning: summary.running + summary.workflows > 0,
    label,
    attention: summary.attention ? `? ${summary.attention} needs input` : "",
  };
}

// A worker tab the list opened is temporary: once the worker has reported and is idle,
// it closes whenever the user is not looking at it, so its Location can go idle again.
export function reportedTabAction(
  worker: { report: unknown },
  status: "idle" | "running",
  tab:
    | { readonly active: boolean; readonly busy: boolean; readonly attention: boolean }
    | undefined,
): "keep" | "close" | "forget" {
  if (worker.report === null || status === "running") return "keep";
  if (!tab) return "forget";
  return tab.active || tab.busy || tab.attention ? "keep" : "close";
}

export function cleanRoleTitle(title: string, managed: boolean) {
  if (!managed) return title;
  const remainder = title.replace(/^\[(?:Main|Worker)\] /, "");
  return remainder.trim() ? remainder : title;
}

export function activityTime(time: {
  idle?: number;
  updated: number;
  created: number;
}) {
  return time.idle ?? time.updated ?? time.created;
}

export function activitySubtitle(input: {
  directory: string;
  project?: { name?: string; canonical: string };
  role?: "Main" | "Worker";
}) {
  const folder = (path: string) =>
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path;
  const location = folder(input.directory);
  const project =
    input.project?.name?.trim() ||
    (input.project ? folder(input.project.canonical) : location);
  const parts = [project];
  if (input.role) parts.push(input.role);
  if (
    input.project &&
    input.project.canonical !== input.directory &&
    location !== project
  )
    parts.push(location);
  return parts.join(" · ");
}

export function dateGroup(timestamp: number, now = new Date()) {
  const date = new Date(timestamp);
  const day = (value: Date) =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const age = (day(now) - day(date)) / 86400000;
  if (age === 0) return "Today";
  if (age === 1) return "Yesterday";
  if (age > 1 && age < 7)
    return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function priority(item: ActivityItem) {
  return item.attention ? 3 : item.busy ? 2 : item.unread ? 1 : 0;
}

function visible(item: ActivityItem) {
  return !item.hidden || item.open || item.active || item.busy || item.attention;
}

function compare(a: ActivityItem, b: ActivityItem) {
  return (
    priority(b) - priority(a) ||
    Number(b.pinned) - Number(a.pinned) ||
    b.updated - a.updated ||
    a.id.localeCompare(b.id)
  );
}

export function activityGroups(items: ActivityItem[], now = new Date()) {
  const groups = new Map<string, ActivityItem[]>();
  const ordered = items.filter(visible).sort(compare);
  for (const item of ordered) {
    const key = priority(item)
      ? "Priority"
      : item.pinned
        ? "Pinned"
        : dateGroup(item.updated, now);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

export function activityList<Item extends ListItem>(items: Item[]) {
  const groups = new Map<ListCategory, Item[]>();
  for (const item of items
    .filter((item) => item.closed || visible(item))
    .sort(compare)) {
    const category = listCategory(item);
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return listOrder.flatMap((category) => {
    const group = groups.get(category);
    return group ? [[category, group] as const] : [];
  });
}

export function activityThreads(items: ActivityItem[], now = new Date()) {
  const available = new Map(items.filter(visible).map((item) => [item.id, item]));
  const children = new Map<string, ActivityItem[]>();
  const roots: ActivityItem[] = [];
  for (const item of available.values()) {
    const parent = item.coordinatorID
      ? available.get(item.coordinatorID)
      : undefined;
    if (parent && parent.id !== item.id && !parent.coordinatorID) {
      const siblings = children.get(parent.id) ?? [];
      siblings.push(item);
      children.set(parent.id, siblings);
    } else roots.push(item);
  }
  const threads = new Map<string, ActivityThread>();
  const summaries = roots.map((item) => {
    const workers = (children.get(item.id) ?? []).sort(compare);
    const members = [item, ...workers];
    const status = {
      attention: members.some((member) => member.attention),
      busy: members.some((member) => member.busy),
      unread: members.some((member) => member.unread === "error")
        ? ("error" as const)
        : members.find((member) => member.unread)?.unread,
    };
    threads.set(item.id, { item, children: workers, status });
    return {
      ...item,
      ...status,
      pinned: members.some((member) => member.pinned),
      updated: Math.max(...members.map((member) => member.updated)),
    };
  });
  return new Map(
    [...activityGroups(summaries, now)].map(([name, group]) => [
      name,
      group.flatMap((item) => {
        const thread = threads.get(item.id);
        return thread ? [thread] : [];
      }),
    ]),
  );
}
