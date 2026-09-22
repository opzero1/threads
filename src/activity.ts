import type { Plugin } from "@opencode/plugin/tui";
import type { BoxRenderable, TextRenderable } from "@opentui/core";
import { z } from "zod";
import {
  activityThreads,
  activitySubtitle,
  activityTime,
  cleanRoleTitle,
  type ActivityItem,
} from "./activity-model";
import { activityRail } from "./activity-rail";
import { themeColor, themeHue, themeMuted } from "./activity-theme";
import { ActivityPicker } from "./activity-picker";
import { ThreadsRpc, WorkerView } from "./rpc";

type Session = NonNullable<
  ReturnType<Plugin.Context["data"]["session"]["get"]>
>;
const Link = z
  .object({
    workerID: z.string(),
    coordinatorID: z.string(),
    key: z.string(),
    fingerprint: z.string(),
    initialMessageID: z.string(),
    reportMessageID: z.string(),
  })
  .strict();

export function activity(
  ctx: Plugin.Context,
  core: Pick<
    typeof import("@opentui/core"),
    | "BoxRenderable"
    | "ScrollBoxRenderable"
    | "TextRenderable"
    | "TextAttributes"
    | "RGBA"
  >,
  solid: Pick<typeof import("solid-js"), "createEffect" | "createSignal">,
  Spinner:
    | ReturnType<
        typeof import("@opentui/solid/components").getComponentCatalogue
      >["spinner"]
    | undefined,
) {
  const { BoxRenderable, ScrollBoxRenderable, TextRenderable, TextAttributes } =
    core;
  const { createEffect, createSignal } = solid;
  const fallbackColor = core.RGBA.fromHex("#808080");
  const [revision, setRevision] = createSignal(0);
  const [pins, savePins] = ctx.storage.store("activity-pins", {
    initial: { ids: [] as string[] },
  });
  const [sections, saveSections] = ctx.storage.store("activity-sections", {
    initial: { collapsed: [] as string[] },
  });
  const [threadState, saveThreadState] = ctx.storage.store("activity-threads", {
    initial: { collapsed: [] as string[] },
  });
  const [dismissed, saveDismissed] = ctx.storage.store("activity-dismissed", {
    initial: { ids: [] as string[] },
  });
  const closingRows = new Set<string>();
  const sessions = new Map<string, Session>();
  const workers = new Map<string, z.infer<typeof WorkerView>>();
  const deleted = new Set<string>();
  const abort = new AbortController();
  const rpc = ctx.client.rpc(ThreadsRpc);
  let stopped = false;
  let loading = false;
  let lastError: string | undefined;
  let render = () => {};
  const changed = () => {
    if (!stopped) setRevision((value) => value + 1);
  };
  const error = (value: unknown) => {
    const detail = z.object({ message: z.string() }).safeParse(value);
    const message = `Activity: ${detail.success ? detail.data.message : String(value)}`;
    if (!stopped && message !== lastError)
      ctx.ui.toast.show({ message, variant: "error" });
    lastError = message;
  };
  async function pin(id: string) {
    try {
      await savePins((draft) => {
        draft.ids = draft.ids.includes(id)
          ? draft.ids.filter((value) => value !== id)
          : [...draft.ids, id];
      });
      changed();
    } catch (value) {
      error(value);
    }
  }
  async function restore(ids: string[]) {
    if (!ids.some((id) => dismissed.ids.includes(id))) return;
    await saveDismissed((draft) => {
      draft.ids = draft.ids.filter((id) => !ids.includes(id));
    });
    changed();
  }
  async function focus(id: string) {
    try {
      await restore([id]);
      if (!stopped) ctx.ui.tabs.focus(id);
    } catch (value) {
      error(value);
    }
  }
  async function close(id: string) {
    if (stopped || closingRows.has(id)) return;
    closingRows.add(id);
    try {
      if (
        ctx.ui.tabs.list().some((tab) => tab.sessionID === id) &&
        !ctx.ui.tabs.close(id)
      )
        return;
      await saveDismissed((draft) => {
        if (!draft.ids.includes(id)) draft.ids.push(id);
      });
    } catch (value) {
      error(value);
    } finally {
      closingRows.delete(id);
      changed();
    }
  }
  async function toggleSection(name: string) {
    try {
      await saveSections((draft) => {
        draft.collapsed = draft.collapsed.includes(name)
          ? draft.collapsed.filter((value) => value !== name)
          : [...draft.collapsed, name];
      });
      changed();
    } catch (value) {
      error(value);
    }
  }
  async function toggleThread(id: string) {
    try {
      await saveThreadState((draft) => {
        draft.collapsed = draft.collapsed.includes(id)
          ? draft.collapsed.filter((value) => value !== id)
          : [...draft.collapsed, id];
      });
      changed();
    } catch (value) {
      error(value);
    }
  }
  function items(includeDismissed = false) {
    revision();
    const tabs = new Map(ctx.ui.tabs.list().map((tab) => [tab.sessionID, tab]));
    const merged = new Map(sessions);
    for (const id of [
      ...tabs.keys(),
      ...pins.ids,
      ...[...workers.values()].map((worker) => worker.coordinatorID),
    ]) {
      const session = ctx.data.session.get(id);
      if (session) merged.set(id, session);
    }
    const result: ActivityItem[] = [];
    const coordinators = new Set(
      [...workers.values()].map((worker) => worker.coordinatorID),
    );
    for (const saved of merged.values()) {
      const session = ctx.data.session.get(saved.id) ?? saved;
      if (deleted.has(session.id) || session.parentID || session.time.archived)
        continue;
      const tab = tabs.get(session.id);
      const isDismissed = dismissed.ids.includes(session.id);
      if (!includeDismissed && isDismissed && !tab?.active) continue;
      const link = Link.safeParse(session.metadata?.opThreads);
      const worker = workers.get(session.id);
      const attention = tab
        ? tab.attention
        : Boolean(
            ctx.data.session.permission.list(session.id)?.length ||
              ctx.data.session.form.list(session.id)?.length,
          );
      const busy = tab
        ? tab.busy
        : ctx.data.session.status(session.id) === "running";
      // Unknown history-worker visibility must not resurrect an auto-hidden worker.
      if (
        link.success &&
        !tab &&
        !busy &&
        !attention &&
        !(includeDismissed && isDismissed)
      )
        continue;
      const role =
        worker &&
        link.success &&
        link.data.workerID === session.id &&
        link.data.coordinatorID === worker.coordinatorID
          ? "Worker"
          : coordinators.has(session.id)
            ? "Main"
            : undefined;
      result.push({
        id: session.id,
        title: cleanRoleTitle(
          tab?.title ?? session.title ?? "Untitled",
          role !== undefined,
        ),
        subtitle: activitySubtitle({
          directory: session.location.directory,
          project: ctx.data.project.get(session.projectID),
          role,
        }),
        updated: activityTime(session.time),
        active: tab?.active ?? false,
        attention,
        busy,
        unread: tab?.unread,
        pinned: pins.ids.includes(session.id),
        hidden: includeDismissed && isDismissed ? false : worker?.hidden ?? false,
        open: Boolean(tab),
        coordinatorID: role === "Worker" ? worker?.coordinatorID : undefined,
      });
    }
    return activityThreads(result);
  }
  async function resolveSession(id: string) {
    if (stopped || sessions.has(id) || deleted.has(id)) return;
    try {
      const result = await ctx.client.session.get(
        { sessionID: id },
        { signal: abort.signal },
      );
      if (!stopped) sessions.set(id, result);
    } catch (value) {
      const missing = z
        .object({
          _tag: z.literal("SessionNotFoundError"),
          sessionID: z.string(),
        })
        .safeParse(value);
      if (!missing.success || missing.data.sessionID !== id) throw value;
      deleted.add(id);
      if (pins.ids.includes(id))
        await savePins((draft) => {
          draft.ids = draft.ids.filter((value) => value !== id);
        });
      await restore([id]);
    }
  }
  async function load() {
    if (loading || stopped) return;
    loading = true;
    try {
      const page = await ctx.client.session.list(
        {
          parentID: null,
          limit: 100,
          order: "desc",
        },
        { signal: abort.signal },
      );
      if (stopped) return;
      for (const session of page.data) sessions.set(session.id, session);
      for (const id of new Set([...pins.ids, ...dismissed.ids]))
        await resolveSession(id);
      const ids = [
        ...new Set(
          [...sessions.values()].flatMap((session) => {
            const link = Link.safeParse(session.metadata?.opThreads);
            return link.success
              ? [session.id, link.data.coordinatorID]
              : [session.id];
          }),
        ),
      ];
      for (let index = 0; index < ids.length && !stopped; index += 100) {
        const result = await rpc.snapshot(
          { coordinatorIDs: ids.slice(index, index + 100) },
          {
            signal: abort.signal,
            location: ctx.location ?? ctx.data.location.default(),
          },
        );
        for (const worker of result.workers) workers.set(worker.workerID, worker);
      }
      for (const id of new Set(
        [...workers.values()].map((worker) => worker.coordinatorID),
      )) {
        await resolveSession(id);
      }
      lastError = undefined;
    } catch (value) {
      error(value);
    } finally {
      loading = false;
      changed();
    }
  }
  async function actions(item: ActivityItem, hasChildren: boolean) {
    const action = await ctx.ui.dialog.select({
      title: item.title,
      options: [
        { title: item.pinned ? "Unpin" : "Pin", value: "pin" },
        {
          title: "Close from Activity (keep history)",
          value: "close",
        },
        ...(hasChildren
          ? [{
              title: threadState.collapsed.includes(item.id)
                ? "Expand workers"
                : "Collapse workers",
              value: "workers",
            }]
          : []),
      ],
    });
    if (stopped) return;
    if (action === "pin") await pin(item.id);
    if (action === "close") await close(item.id);
    if (action === "workers") await toggleThread(item.id);
  }
  const rail = activityRail(ctx, core, (content) => {
    const runningIndicator = (id: string) => {
      if (!Spinner) return;
      const node = new Spinner(ctx.renderer, {
        id: `activity-running-${id}`,
        frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        interval: 80,
        color: themeColor(ctx.theme.text, fallbackColor),
      });
      if ("color" in node) return node;
      node.destroy();
    };
    const text = (value: string) =>
      new TextRenderable(ctx.renderer, {
        content: value,
        fg: themeColor(ctx.theme.text, fallbackColor),
        height: 1,
        flexShrink: 0,
      });
    const header = text("Activity");
    header.attributes = TextAttributes.BOLD;
    content.add(header);
    const fresh = text("+ New session");
    fresh.id = "activity-new-session";
    fresh.marginTop = 1;
    fresh.marginBottom = 1;
    fresh.onMouseUp = (event) => {
      event.stopPropagation();
      if (event.button === 0) ctx.keymap.dispatch("session.new");
    };
    content.add(fresh);
    const scroll = new ScrollBoxRenderable(ctx.renderer, {
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
    });
    content.add(scroll);
    const rows = new Map<
      string,
      {
        box: BoxRenderable;
        selected: TextRenderable;
        status: BoxRenderable;
        marker: TextRenderable;
        spinner: ReturnType<typeof runningIndicator>;
        title: TextRenderable;
        subtitle: TextRenderable;
        workers: TextRenderable | undefined;
        pin: TextRenderable;
        close: TextRenderable;
      }
    >();
    const headings = new Map<
      string,
      { box: BoxRenderable; label: TextRenderable }
    >();
    const help = text("/activities");
    content.add(help);
    render = () => {
      const fg = themeColor(ctx.theme.text, fallbackColor);
      const muted = themeMuted(ctx.theme.text, fg);
      const background =
        ctx.theme.background.raised?.base ??
        themeColor(ctx.theme.background, fallbackColor);
      const accent = themeHue(ctx.theme.hue?.accent, fg, background);
      const workerColor = themeHue(ctx.theme.hue?.purple, fg, background);
      const runningColor = themeColor(ctx.theme.text.feedback.info, fg);
      const attentionColor = themeColor(ctx.theme.text.feedback.warning, fg);
      header.fg = accent;
      fresh.fg = accent;
      help.fg = muted;
      const desired: (BoxRenderable | TextRenderable)[] = [];
      const keep = new Set<string>();
      const groups = items();
      for (const [name, group] of groups) {
        let heading = headings.get(name);
        if (!heading) {
          const box = new BoxRenderable(ctx.renderer, {
            id: `activity-section-${encodeURIComponent(name)}`,
            flexDirection: "column",
            flexShrink: 0,
            shouldFill: false,
            onMouseUp(event) {
              event.stopPropagation();
              if (event.button === 0) void toggleSection(name);
            },
          });
          const label = text("");
          label.attributes = TextAttributes.BOLD;
          box.add(label);
          heading = { box, label };
          headings.set(name, heading);
        }
        const collapsed = sections.collapsed.includes(name);
        heading.box.border = desired.length ? ["top"] : false;
        heading.box.borderColor = themeColor(ctx.theme.border, fg);
        heading.box.height = desired.length ? 3 : 2;
        heading.label.fg =
          name === "Priority"
            ? attentionColor
            : name === "Pinned"
              ? workerColor
              : accent;
        const count = group.reduce(
          (total, thread) => total + 1 + thread.children.length,
          0,
        );
        heading.label.content = `${collapsed ? "▸" : "▾"} ${name} (${count})`;
        desired.push(heading.box);
        if (collapsed) continue;
        const displayed = group.flatMap((thread) => {
          const collapsed = threadState.collapsed.includes(thread.item.id);
          return [
            {
              item: thread.item,
              depth: 0,
              children: thread.children.length,
              collapsed,
              status: collapsed ? thread.status : thread.item,
            },
            ...(collapsed
              ? []
              : thread.children.map((item) => ({
                  item,
                  depth: 1,
                  children: 0,
                  collapsed: false,
                  status: item,
                }))),
          ];
        });
        for (const { item, depth, children, collapsed, status } of displayed) {
          keep.add(item.id);
          let row = rows.get(item.id);
          if (!row) {
            const box = new BoxRenderable(ctx.renderer, {
              id: `activity-row-${item.id}`,
              height: 3,
              flexShrink: 0,
              flexDirection: "column",
            });
            const line = new BoxRenderable(ctx.renderer, {
              height: 1,
              flexShrink: 0,
              flexDirection: "row",
            });
            const selected = text("");
            selected.id = `activity-selected-${item.id}`;
            selected.width = 2;
            const status = new BoxRenderable(ctx.renderer, {
              width: 2,
              height: 1,
              flexShrink: 0,
            });
            const marker = text("");
            marker.id = `activity-marker-${item.id}`;
            status.add(marker);
            const title = text("");
            title.id = `activity-title-${item.id}`;
            title.flexShrink = 1;
            title.minWidth = 0;
            title.wrapMode = "none";
            title.truncate = true;
            const pinButton = text("");
            pinButton.id = `activity-pin-${item.id}`;
            pinButton.marginLeft = 2;
            pinButton.width = 4;
            const closeButton = text("");
            closeButton.id = `activity-close-${item.id}`;
            closeButton.marginLeft = 1;
            closeButton.width = 4;
            row = {
              box,
              selected,
              status,
              marker,
              spinner: undefined,
              title,
              subtitle: text(""),
              workers: undefined,
              pin: pinButton,
              close: closeButton,
            };
            line.add(selected);
            line.add(status);
            line.add(title);
            line.add(pinButton);
            line.add(closeButton);
            box.add(line);
            row.subtitle.id = `activity-subtitle-${item.id}`;
            row.subtitle.wrapMode = "none";
            row.subtitle.truncate = true;
            box.add(row.subtitle);
            rows.set(item.id, row);
          }
          row.box.marginLeft = depth * 3;
          row.box.height = children ? 5 : 3;
          const running = status.busy && !status.attention;
          if (running && !row.spinner) {
            row.spinner = runningIndicator(item.id);
            if (row.spinner) row.status.add(row.spinner);
          } else if (!running && row.spinner) {
            row.spinner.destroy();
            row.spinner = undefined;
          }
          if (row.spinner) row.spinner.color = runningColor;
          row.selected.content = item.active ? "> " : "  ";
          row.selected.fg = accent;
          row.selected.attributes = item.active ? TextAttributes.BOLD : 0;
          row.marker.content = status.attention
            ? "?"
            : running
              ? "⠋"
              : status.unread === "error"
                ? "!"
                : status.unread
                  ? "•"
                  : " ";
          row.marker.visible = !row.spinner;
          row.marker.fg = status.attention
            ? attentionColor
            : running
              ? runningColor
              : status.unread === "error"
                ? themeColor(ctx.theme.text.feedback.error, fg)
                : accent;
          row.title.content = item.title;
          row.title.fg = status.attention
            ? attentionColor
            : item.active
              ? accent
              : fg;
          row.subtitle.fg = muted;
          row.title.attributes = item.active ? TextAttributes.BOLD : 0;
          row.subtitle.content = `  ${item.subtitle}`;
          if (children && !row.workers) {
            row.workers = text("");
            row.workers.id = `activity-workers-${item.id}`;
            row.workers.marginLeft = 3;
            row.workers.marginTop = 1;
            row.workers.attributes = TextAttributes.BOLD;
            row.workers.onMouseUp = (event) => {
              event.stopPropagation();
              if (event.button === 0) void toggleThread(item.id);
            };
            row.box.add(row.workers);
          } else if (!children && row.workers) {
            row.workers.destroy();
            row.workers = undefined;
          }
          if (row.workers) {
            row.workers.content = `${collapsed ? "▸" : "▾"} Workers (${children})`;
            row.workers.fg = workerColor;
          }
          row.pin.content = item.pinned ? "[◆] " : "[◇] ";
          row.pin.fg = item.pinned ? workerColor : muted;
          row.pin.attributes = TextAttributes.BOLD;
          row.pin.onMouseUp = (event) => {
            event.stopPropagation();
            if (event.button === 0) void pin(item.id);
          };
          row.close.content = "[×] ";
          row.close.fg = muted;
          row.close.attributes = TextAttributes.BOLD;
          row.close.onMouseUp = (event) => {
            event.stopPropagation();
            if (event.button === 0) void close(item.id);
          };
          row.box.onMouseUp = (event) => {
            event.stopPropagation();
            if (event.button === 0) void focus(item.id);
            if (event.button === 2) void actions(item, children > 0);
          };
          desired.push(row.box);
        }
      }
      for (const [id, row] of rows)
        if (!keep.has(id)) {
          row.box.destroyRecursively();
          rows.delete(id);
        }
      for (const [name, heading] of headings)
        if (!groups.has(name)) {
          heading.box.destroyRecursively();
          headings.delete(name);
        }
      for (const [index, node] of desired.entries())
        if (scroll.getChildren()[index] !== node) scroll.add(node, index);
    };
    render();
    return () => {
      render = () => {};
    };
  });
  rail.toggle(ctx.options.activity !== false);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const stopEvents = ctx.data.listen(({ details }) => {
    if (!details.type.startsWith("session.")) return;
    if (details.type === "session.deleted") {
      const sessionID = details.data.sessionID;
      deleted.add(sessionID);
      sessions.delete(sessionID);
      workers.delete(sessionID);
      void restore([sessionID]).catch(error);
      if (pins.ids.includes(sessionID))
        void savePins((draft) => {
          draft.ids = draft.ids.filter((id) => id !== sessionID);
        }).catch(error);
      changed();
    }
    if (details.type === "session.created") {
      deleted.delete(details.data.sessionID);
      changed();
    }
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void load();
      }, 1000);
  });
  const timer = setInterval(() => {
    rail.invalidate();
    changed();
    void load();
  }, 30000);
  const removeSlot = ctx.ui.slot({
    append: "app",
    render() {
      let selected: string | undefined;
      createEffect(() => {
        const route = ctx.ui.router.current();
        const id = route.type === "session" ? route.sessionID : undefined;
        if (id === selected) return;
        selected = id;
        if (id && !closingRows.has(id)) void restore([id]).catch(error);
      });
      createEffect(() => {
        ctx.themeMode;
        themeColor(ctx.theme.text, fallbackColor);
        themeColor(ctx.theme.border, fallbackColor);
        sections.collapsed.length;
        threadState.collapsed.length;
        items();
        render();
        rail.invalidate();
      });
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "threads.activity.threads",
            title: "Expand/collapse managed workers",
            palette: true,
            slash: { name: "activity-threads" },
            async run() {
              const id = await ctx.ui.dialog.select({
                title: "Managed worker stacks",
                options: [...items().values()]
                  .flat()
                  .filter((thread) => thread.children.length)
                  .map((thread) => ({
                    title: `${threadState.collapsed.includes(thread.item.id) ? "Expand" : "Collapse"} ${thread.item.title}`,
                    description: `${thread.children.length} workers`,
                    value: thread.item.id,
                  })),
              });
              if (id && !stopped) await toggleThread(id);
            },
          },
          {
            id: "threads.activity.sections",
            title: "Expand/collapse Activity section",
            palette: true,
            slash: { name: "activity-sections" },
            async run() {
              const name = await ctx.ui.dialog.select({
                title: "Activity sections",
                options: [...items()].map(([name, group]) => ({
                  title: `${sections.collapsed.includes(name) ? "Expand" : "Collapse"} ${name}`,
                  description: `${group.reduce((total, thread) => total + 1 + thread.children.length, 0)} conversations`,
                  value: name,
                })),
              });
              if (name && !stopped) await toggleSection(name);
            },
          },
          {
            id: "threads.activity.toggle",
            title: "Toggle Activity sidebar",
            palette: true,
            slash: { name: "activity" },
            run() {
              rail.toggle();
            },
          },
          {
            id: "threads.activity.pin",
            title: "Pin/unpin current Activity conversation",
            palette: true,
            slash: { name: "pin" },
            async run() {
              const route = ctx.ui.router.current();
              if (route.type === "session") await pin(route.sessionID);
            },
          },
          {
            id: "threads.activity.choose",
            title: "Choose Activity conversation",
            palette: true,
            slash: { name: "activities" },
            run() {
              const route = ctx.ui.router.current();
              ctx.ui.dialog.show(() => ActivityPicker({
                ctx,
                fallbackColor,
                current: route.type === "session" ? route.sessionID : undefined,
                items: () => [...items(true)].flatMap(([category, group]) =>
                  group
                    .flatMap((thread) => [thread.item, ...thread.children])
                    .map((item) => ({
                      ...item,
                      category,
                      closed: dismissed.ids.includes(item.id),
                    })),
                ),
                pin,
                open: focus,
              }));
            },
          },
        ],
      }));
      return null;
    },
  });
  void load();
  return {
    mounted: rail.mounted,
    isDismissed: (id: string) => closingRows.has(id) || dismissed.ids.includes(id),
    restore,
    updateWorkers(values: z.infer<typeof WorkerView>[]) {
      for (const worker of values) workers.set(worker.workerID, worker);
      changed();
    },
    dispose() {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      clearTimeout(refreshTimer);
      stopEvents();
      removeSlot();
      rail.dispose();
    },
  };
}
