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
