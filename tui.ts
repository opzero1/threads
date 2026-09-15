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
    async function reconcile(reopen = false) {
      if (stopped || !ctx.ui.tabs.enabled()) return;
      if (running) {
        reopenPending ||= reopen;
        return;
      }
      running = true;
      try {
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
