export type ActivityItem = {
  id: string;
  title: string;
  subtitle: string;
  updated: number;
  active: boolean;
  attention: boolean;
  busy: boolean;
  unread?: "activity" | "error";
  hidden: boolean;
  open: boolean;
};

export type ListCategory =
  | "Needs attention"
  | "Running"
  | "Main"
  | "Finished"
  | "Closed";
const listOrder: ListCategory[] = [
  "Needs attention",
  "Running",
  "Main",
  "Finished",
  "Closed",
];
export type ListItem = ActivityItem & { closed: boolean; worker: boolean };

export function listCategory(item: ListItem): ListCategory {
  if (item.closed) return "Closed";
  if (item.attention) return "Needs attention";
  if (item.busy) return "Running";
  return item.worker ? "Finished" : "Main";
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

function priority(item: ActivityItem) {
  return item.attention ? 3 : item.busy ? 2 : item.unread ? 1 : 0;
}

function visible(item: ActivityItem) {
  return !item.hidden || item.open || item.active || item.busy || item.attention;
}

function compare(a: ActivityItem, b: ActivityItem) {
  return (
    priority(b) - priority(a) ||
    b.updated - a.updated ||
    a.id.localeCompare(b.id)
  );
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
