import { Plugin } from "@opencode/plugin/tui";
import { getComponentCatalogue } from "@opentui/solid/components";
import { createEffect, createSignal } from "solid-js";
import { z } from "zod";
import { ThreadsRpc } from "./src/rpc";
import { activity } from "./src/activity";
import { workflowUI } from "./src/workflow-ui";
import {
  cleanRoleTitle,
  reportedTabAction,
  threadsOptions,
} from "./src/activity-model";
import { workInProgress, workerWorking } from "./src/idle";
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextAttributes,
  RGBA,
} from "@opentui/core";

const CoordinatorRef = z.object({ coordinatorID: z.string() });

export default Plugin.define({
  id: "op-threads",
  setup(ctx) {
    const settings = threadsOptions(ctx.options);
    const workflows = workflowUI(ctx);
    const rpc = ctx.client.rpc(ThreadsRpc);
    const sidebar = activity(
      ctx,
      { BoxRenderable, ScrollBoxRenderable, TextRenderable, TextAttributes, RGBA },
      { createEffect, createSignal },
      getComponentCatalogue().spinner,
      { mode: settings.activity, workflows: workflows.active },
    );
    const [cleaned, saveCleaned] = ctx.storage.store("role-title-cleanup", {
      initial: { ids: [] as string[] },
    });
    const initial: { workerIDs: string[] } = { workerIDs: [] };
    const [seen, updateSeen] = ctx.storage.memory("seen-workers", { initial });
    const closing = new Set<string>();
    const abort = new AbortController();
    let stopped = false;
    let running = false;
    let reopenPending = false;
    let refreshPending = false;
    let lastError: string | undefined;
    let movingFrom: string | undefined;
    let known: string[] = [];
    function groupTabs() {
      if (sidebar.mounted()) return;
      const tabs = ctx.ui.tabs.list().map((tab) => {
        const projectID = ctx.data.session.get(tab.sessionID)?.projectID;
        return {
          sessionID: tab.sessionID,
          priority: tab.busy || tab.attention,
          projectID:
            typeof projectID === "string" && projectID.length > 0
              ? projectID
              : undefined,
        };
      });
      const groups = new Map<string, typeof tabs>();
      for (const tab of tabs) {
        const key =
          tab.projectID === undefined
            ? `session:${tab.sessionID}`
            : `project:${tab.projectID}`;
        const group = groups.get(key);
        if (group) group.push(tab);
        else groups.set(key, [tab]);
      }
      const ordered = [...groups.values()].flatMap((group) =>
        group
          .sort((left, right) => Number(right.priority) - Number(left.priority))
          .map((tab) => tab.sessionID),
      );
      const current = tabs.map((tab) => tab.sessionID);
      const stamp = JSON.stringify(current);
      if (movingFrom === stamp) return;
      movingFrom = undefined;
      for (const [index, sessionID] of ordered.entries()) {
        if (current[index] === sessionID) continue;
        if (ctx.ui.tabs.move(sessionID, index)) movingFrom = stamp;
        break;
      }
    }
    function trackedCoordinatorIDs() {
      const route = ctx.ui.router.current();
      return [
        ...new Set(
          [
            ...ctx.ui.tabs.list().map((tab) => tab.sessionID),
            ...(route.type === "session" ? [route.sessionID] : []),
          ].flatMap((sessionID) => {
            const link = CoordinatorRef.safeParse(
              ctx.data.session.get(sessionID)?.metadata?.opThreads,
            );
            return link.success
              ? [sessionID, link.data.coordinatorID]
              : [sessionID];
          }),
        ),
      ].slice(0, 100);
    }
    async function reconcile(reopen = false) {
      if (stopped || !ctx.ui.tabs.enabled()) return;
      if (running) {
        reopenPending ||= reopen;
        // Coalesce, never drop: the last session event can be the one that finishes a worker.
        refreshPending = true;
        return;
      }
      running = true;
      refreshPending = false;
      try {
        groupTabs();
        const coordinatorIDs = trackedCoordinatorIDs();
        if (!coordinatorIDs.length) return;
        const { workers } = await (reopen ? rpc.restore : rpc.snapshot)(
          { coordinatorIDs },
          {
            location: ctx.location ?? ctx.data.location.default(),
            signal: abort.signal,
          },
        );
        known = workers.map((worker) => worker.workerID);
        if (reopen)
          await sidebar.restore(workers.map((worker) => worker.workerID));
        sidebar.updateWorkers(workers);
        for (const worker of workers) {
          if (stopped) return;
          if (!reopen && sidebar.isDismissed(worker.workerID)) continue;
          const tab = ctx.ui.tabs
            .list()
            .find((tab) => tab.sessionID === worker.workerID);
          if (closing.has(worker.workerID) && tab) continue;
          const closed = closing.delete(worker.workerID);
          if (!reopen && sidebar.listOpened(worker.workerID)) {
            const action = reportedTabAction(
              worker,
              ctx.data.session.status(worker.workerID),
              tab,
            );
            if (action === "forget")
              await sidebar.forgetListOpened(worker.workerID);
            if (action === "close") {
              if (ctx.ui.tabs.close(worker.workerID)) {
                closing.add(worker.workerID);
                await sidebar.forgetListOpened(worker.workerID);
              }
              continue;
            }
          }
          if (
            worker.hidden &&
            !tab?.active &&
            !tab?.busy &&
            !tab?.attention &&
            ctx.data.session.status(worker.workerID) !== "running"
          ) {
            if (tab) {
              if (!ctx.ui.tabs.close(worker.workerID)) continue;
              closing.add(worker.workerID);
            }
            if (seen.workerIDs.includes(worker.workerID)) {
              updateSeen((draft) => {
                draft.workerIDs = draft.workerIDs.filter(
                  (id) => id !== worker.workerID,
                );
              });
            }
            continue;
          }
          // Worker tabs open on demand from the list unless the auto option is set.
          if (!reopen && settings.workerTabs !== "auto") continue;
          if (!reopen && !closed && seen.workerIDs.includes(worker.workerID))
            continue;
          if (
            !reopen &&
            !tab &&
            !workerWorking(worker, ctx.data.session.status(worker.workerID))
          )
            continue;
          await ctx.data.session.sync(worker.workerID);
          if (
            !stopped &&
            ctx.ui.tabs.open(worker.workerID) &&
            !seen.workerIDs.includes(worker.workerID)
          ) {
            updateSeen((draft) => {
              draft.workerIDs.push(worker.workerID);
            });
          }
        }
        if (!stopped && ctx.ui.tabs.enabled()) {
          const roles = new Map<string, "Main" | "Worker">();
          for (const worker of workers) {
            roles.set(worker.coordinatorID, "Main");
            roles.set(worker.workerID, "Worker");
          }
          for (const tab of ctx.ui.tabs.list()) {
            if (stopped) return;
            const role = roles.get(tab.sessionID);
            const session = ctx.data.session.get(tab.sessionID);
            if (!role || !session || cleaned.ids.includes(tab.sessionID))
              continue;
            const fresh = await ctx.client.session.get(
              { sessionID: tab.sessionID },
              { signal: abort.signal },
            );
            if (stopped) return;
            const title = cleanRoleTitle(fresh.title ?? "", true);
            if (title && title !== fresh.title)
              await ctx.client.session.update(
                { sessionID: tab.sessionID, title },
                { signal: abort.signal },
              );
            if (stopped) return;
            await saveCleaned((draft) => {
              if (!draft.ids.includes(tab.sessionID))
                draft.ids.push(tab.sessionID);
            });
          }
          groupTabs();
        }
        lastError = undefined;
      } catch (error) {
        const message = `Managed worker tabs: ${String(error)}`;
        if (!stopped && message !== lastError)
          ctx.ui.toast.show({ message, variant: "error" });
        lastError = message;
      } finally {
        running = false;
        if (reopenPending) {
          reopenPending = false;
          void reconcile(true);
        } else if (refreshPending && !stopped) void reconcile();
      }
    }
    const refresh = () => {
      void reconcile();
    };
    // Without automatic worker tabs, /threads restores hidden and dismissed workers into
    // the list instead of reopening a tab (and so loading a Location) for each of them.
    async function restoreWorkers() {
      try {
        const ids = trackedCoordinatorIDs();
        if (ids.length) {
          const { workers } = await rpc.restore(
            { coordinatorIDs: ids },
            {
              location: ctx.location ?? ctx.data.location.default(),
              signal: abort.signal,
            },
          );
          if (stopped) return;
          known = [...new Set([...known, ...workers.map((worker) => worker.workerID)])];
          await sidebar.restore(workers.map((worker) => worker.workerID));
          sidebar.updateWorkers(workers);
        }
      } catch (error) {
        if (!stopped)
          ctx.ui.toast.show({
            message: `Managed workers: ${String(error)}`,
            variant: "error",
          });
      }
      if (!stopped) sidebar.openList();
    }
    const stopEvents = ctx.data.listen(({ details }) => {
      if (details.type.startsWith("session.")) refresh();
    });
    const timer = setInterval(() => {
      if (
        workInProgress(ctx.ui.tabs.list(), known, (id) =>
          ctx.data.session.status(id),
        )
      )
        refresh();
    }, 3000);
    const removeSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => {
          ctx.ui.tabs.list();
          refresh();
        });
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "threads.reopen",
              title:
                settings.workerTabs === "auto"
                  ? "Reopen managed worker tabs"
                  : "Restore and list managed workers",
              palette: true,
              slash: { name: "threads" },
              run: () =>
                settings.workerTabs === "auto"
                  ? reconcile(true)
                  : restoreWorkers(),
            },
          ],
        }));
        return null;
      },
    });
    refresh();
    return () => {
      workflows.dispose();
      stopped = true;
      abort.abort();
      sidebar.dispose();
      clearInterval(timer);
      stopEvents();
      removeSlot();
    };
  },
});
