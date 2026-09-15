import { Plugin } from "@opencode/plugin/tui";
import { createEffect } from "solid-js";
import { z } from "zod";

export default Plugin.define({
  id: "op-threads-tui-probe",
  async setup(context) {
    const path = context.options.path;
    if (typeof path !== "string")
      throw new Error("Probe output path is required");
    const openSessionIDs = z.array(z.string()).default([]).parse(context.options.openSessionIDs);
    for (const sessionID of openSessionIDs) {
      await context.data.session.sync(sessionID);
      context.ui.tabs.open(sessionID);
    }
    let writes = Promise.resolve();
    return context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "probe.arrange",
            bind: "ctrl+g",
            run() {
              for (const [index, sessionID] of openSessionIDs.entries()) {
                context.ui.tabs.move(sessionID, index);
              }
            },
          }],
        }));
        createEffect(() => {
          const snapshot = JSON.stringify({
            tabs: context.ui.tabs.list().map((tab) => ({
              ...tab,
              projectID: context.data.session.get(tab.sessionID)?.projectID,
            })),
            route: context.ui.router.current(),
          });
          writes = writes.then(async () => {
            await Bun.write(path, snapshot);
          });
        });
        return null;
      },
    });
  },
});
