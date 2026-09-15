import { Plugin } from "@opencode/plugin/tui";
import { ThreadsRpc } from "./src/rpc";

export default Plugin.define({
  id: "op-threads",
  setup(ctx) {
    const rpc = ctx.client.rpc(ThreadsRpc);
    const initial: { workerIDs: string[] } = { workerIDs: [] };
    const [seen, updateSeen] = ctx.storage.memory("seen-workers", { initial });
    let stopped = false;
    let running = false;
    let reopenPending = false;
    let lastError: string | undefined;
    function groupTabs() {
      const tabs = ctx.ui.tabs.list().map((tab) => {
        const projectID = ctx.data.session.get(tab.sessionID)?.projectID;
        return {
          sessionID: tab.sessionID,
          priority: tab.busy || tab.active || tab.attention,
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
      for (const [index, sessionID] of ordered.entries()) {
        if (ctx.ui.tabs.list()[index]?.sessionID === sessionID) continue;
        if (!ctx.ui.tabs.move(sessionID, index)) break;
      }
    }
    async function reconcile(reopen = false) {
      if (stopped || !ctx.ui.tabs.enabled()) return;
      if (running) {
        reopenPending ||= reopen;
        return;
      }
      running = true;
      try {
        groupTabs();
        const route = ctx.ui.router.current();
        const coordinatorIDs = [
          ...new Set([
            ...ctx.ui.tabs.list().map((tab) => tab.sessionID),
            ...(route.type === "session" ? [route.sessionID] : []),
          ]),
        ].slice(0, 100);
        if (!coordinatorIDs.length) return;
        const { workers } = await rpc.snapshot(
          { coordinatorIDs },
          { location: ctx.location ?? ctx.data.location.default() },
        );
        for (const worker of workers) {
          if (stopped) return;
          if (!reopen && seen.workerIDs.includes(worker.workerID)) continue;
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
        if (!stopped && ctx.ui.tabs.enabled()) groupTabs();
      } finally {
        running = false;
        if (reopenPending) {
          reopenPending = false;
          void reconcile(true).catch((error) =>
            ctx.ui.toast.show({ message: String(error), variant: "error" }),
          );
        }
      }
    }
    const refresh = () => {
      void reconcile().then(
        () => {
          lastError = undefined;
        },
        (error: unknown) => {
          const message = `Managed worker tabs: ${String(error)}`;
          if (!stopped && message !== lastError)
            ctx.ui.toast.show({ message, variant: "error" });
          lastError = message;
        },
      );
    };
    const stopEvents = ctx.data.listen(({ details }) => {
      if (details.type.startsWith("session.")) refresh();
    });
    const timer = setInterval(refresh, 3000);
    const removeSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "threads.reopen",
              title: "Reopen managed worker tabs",
              palette: true,
              slash: { name: "threads" },
              run: async () => {
                try {
                  await reconcile(true);
                } catch (error) {
                  ctx.ui.toast.show({
                    message: String(error),
                    variant: "error",
                  });
                }
              },
            },
          ],
        }));
        return null;
      },
    });
    refresh();
    return () => {
      stopped = true;
      clearInterval(timer);
      stopEvents();
      removeSlot();
    };
  },
});
