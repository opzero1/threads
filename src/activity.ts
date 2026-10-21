import type { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import { z } from "zod";
import {
  activityList,
  activityTime,
  cleanRoleTitle,
  footerSummary,
  reportedTabAction,
  workerState,
  type ListItem,
} from "./activity-model";
import { ThreadsIndicator } from "./activity-footer";
import { workInProgress } from "./idle";
import { ThreadsRpc, WorkerView } from "./rpc";
import { applyWorkerSnapshot, transportGrace, uiErrorMessage, uiState } from "./ui-location";
import { snapshotEvent } from "./snapshot-events";

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
const CoordinatorRef = z.object({ coordinatorID: z.string() });

export function activity(
  ctx: Plugin.Context,
  color: Pick<typeof RGBA, "fromHex">,
  solid: Pick<typeof import("solid-js"), "createEffect" | "createSignal">,
  spinner: boolean,
  settings: { workflows: () => number; openWorkflows: () => void },
) {
  const { createEffect, createSignal } = solid;
  const fallbackColor = color.fromHex("#808080");
  const [revision, setRevision] = createSignal(0);
  const [dismissed, saveDismissed] = ctx.storage.store("activity-dismissed", {
    initial: { ids: [] as string[] },
  });
  // Unreported workers whose tab the list opened, by TUI folder because native tabs are
  // shared per folder. The tab closes after the worker reports.
  const [listOpened, saveListOpened] = ctx.storage.store("list-opened-workers", {
    initial: { folders: {} as Record<string, string[]> },
  });
  const openedHere = () => listOpened.folders[folder()] ?? [];
  const closingRows = new Set<string>();
  const closingTabs = new Set<string>();
  const sessions = new Map<string, Session>();
  const workers = new Map<string, z.infer<typeof WorkerView>>();
  const deleted = new Set<string>();
  const abort = new AbortController();
  const rpc = ctx.client.rpc(ThreadsRpc);
  let stopped = false;
  let loading = false;
  let pending = false;
  let lastError: string | undefined;
  const transport = transportGrace();
  const changed = () => {
    if (!stopped) setRevision((value) => value + 1);
  };
  const error = (value: unknown) => {
    const message = `Threads: ${uiErrorMessage(value)}`;
    if (!stopped && message !== lastError)
      ctx.ui.toast.show({ message, variant: "error" });
    lastError = message;
  };
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
      if (stopped) return;
      const worker = workers.get(id);
      const opening =
        worker?.report === null &&
        !ctx.ui.tabs.list().some((tab) => tab.sessionID === id);
      if (!ctx.ui.tabs.enabled()) {
        ctx.ui.router.navigate({ type: "session", sessionID: id });
        return;
      }
      const here = folder();
      if (ctx.ui.tabs.focus(id) && opening && !openedHere().includes(id))
        await saveListOpened((draft) => {
          const ids = (draft.folders[here] ??= []);
          if (!ids.includes(id)) ids.push(id);
          if (ids.length > 100) ids.splice(0, ids.length - 100);
        });
    } catch (value) {
      error(value);
    }
  }
  // The TUI's own folder. ctx.location follows the focused session instead.
  function folder() {
    return ctx.data.location.default().directory;
  }
  function currentCoordinator() {
    const route = ctx.ui.router.current();
    if (route.type !== "session") return undefined;
    const link = Link.safeParse(
      (ctx.data.session.get(route.sessionID) ?? sessions.get(route.sessionID))
        ?.metadata?.opThreads,
    );
    return (
      workers.get(route.sessionID)?.coordinatorID ??
      (link.success && link.data.workerID === route.sessionID
        ? link.data.coordinatorID
        : route.sessionID)
    );
  }
  function openSessionIDs() {
    const route = ctx.ui.router.current();
    const current = currentCoordinator();
    return [
      ...ctx.ui.tabs.list().map((tab) => tab.sessionID),
      ...(route.type === "session" ? [route.sessionID] : []),
      ...(current ? [current] : []),
    ];
  }
  function withCoordinators(ids: Iterable<string>) {
    return [
      ...new Set(
        [...ids].flatMap((id) => {
          const link = CoordinatorRef.safeParse(
            (ctx.data.session.get(id) ?? sessions.get(id))?.metadata?.opThreads,
          );
          return link.success ? [id, link.data.coordinatorID] : [id];
        }),
      ),
    ];
  }
  // The Threads list: the current conversation's thread, meaning its main conversation and
  // that conversation's managed workers. Closed workers stay reachable.
  function listItems() {
    revision();
    const main = currentCoordinator();
    if (!main) return [];
    const tabs = new Map(ctx.ui.tabs.list().map((tab) => [tab.sessionID, tab]));
    const coordinators = new Set(
      [...workers.values()].map((worker) => worker.coordinatorID),
    );
    const ids = [
      main,
      ...[...workers.values()]
        .filter((worker) => worker.coordinatorID === main)
        .map((worker) => worker.workerID),
    ];
    const result: ListItem[] = [];
    for (const id of ids) {
      if (deleted.has(id)) continue;
      const session = ctx.data.session.get(id) ?? sessions.get(id);
      const worker = workers.get(id);
      if (!session && !worker) continue;
      if (session && (session.parentID || session.time.archived)) continue;
      const tab = tabs.get(id);
      const closed = dismissed.ids.includes(id) && !tab?.active;
      const attention = tab
        ? tab.attention
        : Boolean(
            ctx.data.session.permission.list(id)?.length ||
              ctx.data.session.form.list(id)?.length,
          );
      const busy = tab ? tab.busy : ctx.data.session.status(id) === "running";
      // Unknown history-worker visibility must not resurrect an auto-hidden worker.
      if (
        !worker &&
        Link.safeParse(session?.metadata?.opThreads).success &&
        !tab &&
        !busy &&
        !attention &&
        !closed
      )
        continue;
      const role = worker ? "Worker" : coordinators.has(id) ? "Main" : undefined;
      result.push({
        id,
        title: cleanRoleTitle(
          tab?.title ?? session?.title ?? worker?.title ?? "Untitled",
          role !== undefined,
        ),
        subtitle: worker ? workerState(worker, busy, attention) : "",
        updated: session ? activityTime(session.time) : 0,
        active: tab?.active ?? false,
        attention,
        busy,
        unread: tab?.unread,
        hidden: closed ? false : worker?.hidden ?? false,
        open: Boolean(tab),
        closed,
        worker: Boolean(worker),
      });
    }
    return activityList(result);
  }
  function summary() {
    revision();
    const main = currentCoordinator();
    const tabs = new Map(ctx.ui.tabs.list().map((tab) => [tab.sessionID, tab]));
    return footerSummary(
      [...workers.values()]
        .filter((worker) =>
          !deleted.has(worker.workerID) &&
          (main === undefined || worker.coordinatorID === main),
        )
        .map((worker) => {
          const tab = tabs.get(worker.workerID);
          return {
            busy: tab
              ? tab.busy
              : ctx.data.session.status(worker.workerID) === "running",
            attention: tab
              ? tab.attention
              : Boolean(
                  ctx.data.session.permission.list(worker.workerID)?.length ||
                    ctx.data.session.form.list(worker.workerID)?.length,
                ),
          };
        }),
      settings.workflows(),
    );
  }
  async function forgetListOpened(id: string) {
    if (!openedHere().includes(id)) return;
    await saveListOpened((draft) => {
      const ids = (draft.folders[folder()] ?? []).filter((value) => value !== id);
      if (ids.length) draft.folders[folder()] = ids;
      else delete draft.folders[folder()];
    });
  }
  async function toggleDismiss(id: string) {
    if (dismissed.ids.includes(id)) {
      try {
        await restore([id]);
      } catch (value) {
        error(value);
      }
    } else await close(id);
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
      await restore([id]);
    }
  }
  // Worker tabs open only from the Threads list. This closes the ones that are no longer
  // needed: list-opened tabs after their worker reports, and tabs of hidden workers.
  async function reconcileTabs() {
    if (!ctx.ui.tabs.enabled()) return;
    for (const worker of [...workers.values()]) {
      const id = worker.workerID;
      if (stopped) return;
      if (closingRows.has(id) || dismissed.ids.includes(id)) continue;
      const tab = ctx.ui.tabs.list().find((tab) => tab.sessionID === id);
      if (closingTabs.has(id) && tab) continue;
      closingTabs.delete(id);
      const status = ctx.data.session.status(id);
      if (openedHere().includes(id)) {
        const action = reportedTabAction(worker, status, tab);
        if (action === "forget") await forgetListOpened(id);
        if (action === "close") {
          if (ctx.ui.tabs.close(id)) {
            closingTabs.add(id);
            await forgetListOpened(id);
          }
          continue;
        }
      }
      if (
        tab &&
        worker.hidden &&
        !tab.active &&
        !tab.busy &&
        !tab.attention &&
        status !== "running" &&
        ctx.ui.tabs.close(id)
      )
        closingTabs.add(id);
    }
  }
  async function load() {
    if (stopped) return;
    if (loading) {
      // Coalesce, never drop: the last session event can be the one that finishes a worker.
      pending = true;
      return;
    }
    loading = true;
    pending = false;
    try {
      const page = await ctx.client.session.list(
        { parentID: null, limit: 100, order: "desc", directory: folder() },
        { signal: abort.signal },
      );
      if (stopped) return;
      for (const session of page.data) sessions.set(session.id, session);
      for (const id of dismissed.ids) await resolveSession(id);
      const ids = withCoordinators([...openSessionIDs(), ...sessions.keys()]);
      for (let index = 0; index < ids.length && !stopped; index += 100) {
        const coordinatorIDs = ids.slice(index, index + 100);
        const result = await uiState(ctx, coordinatorIDs, (location) => rpc.snapshot(
          { coordinatorIDs },
          {
            signal: abort.signal,
            location,
          },
        ));
        if (stopped) return;
        applyWorkerSnapshot(workers, coordinatorIDs, result.workers);
      }
      await reconcileTabs();
      for (const id of new Set(
        [...workers.values()].map((worker) => worker.coordinatorID),
      )) {
        await resolveSession(id);
      }
      // Session reads do not load a Location; they give listed workers their times.
      for (const worker of [...workers.values()])
        if (!worker.hidden && !ctx.data.session.get(worker.workerID))
          await resolveSession(worker.workerID);
      lastError = undefined;
      transport.clear();
    } catch (value) {
      if (stopped) return;
      if (transport.shouldReport(value)) error(value);
      else
        retry ??= setTimeout(() => {
          retry = undefined;
          void load();
        }, 2000);
    } finally {
      loading = false;
      changed();
      if (pending && !stopped) void load();
    }
  }
  let retry: ReturnType<typeof setTimeout> | undefined;
  // /threads restores hidden and dismissed workers into the list instead of reopening a
  // tab (and so loading a Location) for each of them.
  async function restoreWorkers() {
    try {
      const ids = withCoordinators(openSessionIDs());
      for (let index = 0; index < ids.length && !stopped; index += 100) {
        const coordinatorIDs = ids.slice(index, index + 100);
        const result = await uiState(ctx, coordinatorIDs, (location) => rpc.restore(
          { coordinatorIDs },
          {
            signal: abort.signal,
            location,
          },
        ));
        if (stopped) return;
        applyWorkerSnapshot(workers, coordinatorIDs, result.workers);
        await restore(result.workers.map((worker) => worker.workerID));
      }
    } catch (value) {
      error(value);
    }
    changed();
    if (!stopped) await openList();
  }
  const stopEvents = ctx.data.listen(({ details }) => {
    if (!snapshotEvent(details.type)) return;
    if (details.type === "session.deleted") {
      const sessionID = details.data.sessionID;
      deleted.add(sessionID);
      sessions.delete(sessionID);
      workers.delete(sessionID);
      void restore([sessionID]).catch(error);
      void forgetListOpened(sessionID).catch(error);
      changed();
    }
    if (details.type === "session.created") {
      deleted.delete(details.data.sessionID);
      changed();
    }
    void load();
  });
  const timer = setInterval(() => {
    if (
      workInProgress(ctx.ui.tabs.list(), workers.keys(), (id) =>
        ctx.data.session.status(id),
      )
    )
      void load();
  }, 3000);
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
        ctx.ui.tabs.list();
        void load();
      });
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "threads.activity.choose",
            title: "Show this conversation's workers",
            bind: "<leader>j",
            palette: true,
            slash: { name: "activities" },
            run: openList,
          },
          {
            id: "threads.reopen",
            title: "Restore and list managed workers",
            palette: true,
            slash: { name: "threads" },
            run: restoreWorkers,
          },
        ],
      }));
      return null;
    },
  });
  const row = (id: string) =>
    listItems().flatMap(([category, group]) =>
      group.flatMap((item) => (item.id === id ? [{ ...item, category }] : [])),
    )[0];
  async function openList() {
    const items = listItems();
    if (!items.length) {
      ctx.ui.toast.show({ message: "Open a conversation to see its workers", variant: "info" });
      return;
    }
    const route = ctx.ui.router.current();
    const main = currentCoordinator();
    const session = main
      ? ctx.data.session.get(main) ?? sessions.get(main)
      : undefined;
    const id = await ctx.ui.dialog.select({
      title: session
        ? `Threads · ${cleanRoleTitle(session.title ?? "Untitled", true)}`
        : "Threads",
      current: route.type === "session" ? route.sessionID : undefined,
      options: items.flatMap(([category, group]) =>
        group.map((item) => ({
          title: item.title,
          description: [category, item.subtitle].filter(Boolean).join(" · "),
          value: item.id,
        })),
      ),
    });
    const chosen = id === undefined || stopped ? undefined : row(id);
    if (!chosen) return;
    const action = await ctx.ui.dialog.select({
      title: chosen.title,
      options: [
        { title: "Open", value: "open" as const },
        { title: chosen.closed ? "Restore" : "Dismiss", value: "dismiss" as const },
      ],
    });
    // The list can change while a dialog is open; act only on a row that is still listed.
    const fresh = row(chosen.id);
    if (!action || stopped || !fresh || (action === "dismiss" && fresh.closed !== chosen.closed))
      return;
    await (action === "open" ? focus(chosen.id) : toggleDismiss(chosen.id));
  }
  const indicator = (id: string) => () =>
    ThreadsIndicator({
      ctx,
      id,
      fallbackColor,
      spinner,
      summary,
      shortcut: () => ctx.keymap.shortcuts("threads.activity.choose")[0],
      open: () => void openList(),
      openWorkflows: settings.openWorkflows,
    });
  const removeFooter = ctx.ui.slot({
    append: "prompt.footer.status",
    render: indicator("threads-footer"),
  });
  const removeHomeFooter = ctx.ui.slot({
    append: "home.footer.status",
    render: indicator("threads-home-footer"),
  });
  void load();
  return () => {
    stopped = true;
    abort.abort();
    clearInterval(timer);
    clearTimeout(retry);
    stopEvents();
    removeSlot();
    removeFooter();
    removeHomeFooter();
  };
}
