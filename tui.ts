import { Plugin } from "@opencode/plugin/tui";
import { getComponentCatalogue } from "@opentui/solid/components";
import { createEffect, createSignal } from "solid-js";
import { z } from "zod";
import { ThreadsRpc } from "./src/rpc";
import { activity } from "./src/activity";
import { workflowUI } from "./src/workflow-ui";
import { reportedTabAction } from "./src/activity-model";
import { workInProgress } from "./src/idle";
import { RGBA } from "@opentui/core";

const CoordinatorRef = z.object({ coordinatorID: z.string() });

export default Plugin.define({
  id: "op-threads",
  setup(ctx) {
    const workflows = workflowUI(ctx, RGBA.fromHex("#808080"));
    const rpc = ctx.client.rpc(ThreadsRpc);
    const list = activity(
      ctx,
      RGBA,
      { createEffect, createSignal },
      getComponentCatalogue().spinner !== undefined,
      { workflows: workflows.active, openWorkflows: workflows.open },
    );
    const closing = new Set<string>();
    const abort = new AbortController();
    let stopped = false;
    let running = false;
    let refreshPending = false;
    let lastError: string | undefined;
    let known: string[] = [];
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
    // Worker tabs open only from the Threads list. This closes the ones that are no longer
    // needed: list-opened tabs after their worker reports, and tabs of hidden workers.
    async function reconcile() {
      if (stopped || !ctx.ui.tabs.enabled()) return;
      if (running) {
        // Coalesce, never drop: the last session event can be the one that finishes a worker.
        refreshPending = true;
        return;
      }
      running = true;
      refreshPending = false;
      try {
        const coordinatorIDs = trackedCoordinatorIDs();
        if (!coordinatorIDs.length) return;
        const { workers } = await rpc.snapshot(
          { coordinatorIDs },
          {
            location: ctx.location ?? ctx.data.location.default(),
            signal: abort.signal,
          },
        );
        known = workers.map((worker) => worker.workerID);
        list.updateWorkers(workers);
        for (const worker of workers) {
          if (stopped) return;
          if (list.isDismissed(worker.workerID)) continue;
          const tab = ctx.ui.tabs
            .list()
            .find((tab) => tab.sessionID === worker.workerID);
          if (closing.has(worker.workerID) && tab) continue;
          closing.delete(worker.workerID);
          const status = ctx.data.session.status(worker.workerID);
          if (list.listOpened(worker.workerID)) {
            const action = reportedTabAction(worker, status, tab);
            if (action === "forget")
              await list.forgetListOpened(worker.workerID);
            if (action === "close") {
              if (ctx.ui.tabs.close(worker.workerID)) {
                closing.add(worker.workerID);
                await list.forgetListOpened(worker.workerID);
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
            ctx.ui.tabs.close(worker.workerID)
          )
            closing.add(worker.workerID);
        }
        lastError = undefined;
      } catch (error) {
        const message = `Managed worker tabs: ${String(error)}`;
        if (!stopped && message !== lastError)
          ctx.ui.toast.show({ message, variant: "error" });
        lastError = message;
      } finally {
        running = false;
        if (refreshPending && !stopped) void reconcile();
      }
    }
    const refresh = () => {
      void reconcile();
    };
    // /threads restores hidden and dismissed workers into the list instead of reopening a
    // tab (and so loading a Location) for each of them.
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
          await list.restore(workers.map((worker) => worker.workerID));
          list.updateWorkers(workers);
        }
      } catch (error) {
        if (!stopped)
          ctx.ui.toast.show({
            message: `Managed workers: ${String(error)}`,
            variant: "error",
          });
      }
      if (!stopped) list.openList();
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
    refresh();
    return () => {
      workflows.dispose();
      stopped = true;
      abort.abort();
      list.dispose();
      clearInterval(timer);
      stopEvents();
      removeSlot();
    };
  },
});
