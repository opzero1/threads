import { Plugin } from "@opencode/plugin/tui";
import { appendFile } from "node:fs/promises";
import { createEffect, createSignal } from "solid-js";
import { z } from "zod";

export default Plugin.define({
  id: "op-threads-tui-probe",
  async setup(context) {
    const configuredPath = context.options.path;
    if (typeof configuredPath !== "string")
      throw new Error("Probe output path is required");
    const path = context.options.perProcess
      ? `${configuredPath}.${process.pid}.json`
      : configuredPath;
    const openSessionIDs = z.array(z.string()).default([]).parse(context.options.openSessionIDs);
    const [seeded, updateSeeded] = context.storage.memory("seeded", { initial: { done: false } });
    if (!seeded.done) {
      for (const sessionID of openSessionIDs) {
        await context.data.session.sync(sessionID);
        context.ui.tabs.open(sessionID);
      }
      updateSeeded((draft) => { draft.done = true; });
    }
    let writes = Promise.resolve();
    const [isolateRequests, setIsolateRequests] = createSignal(0);
    const [closeResults, setCloseResults] = createSignal<Record<string, boolean>>({});
    return context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          commands: [{
            id: "probe.arrange",
            bind: "ctrl+g",
            run() {
              for (const [index, sessionID] of openSessionIDs.entries()) {
                context.ui.tabs.move(sessionID, index);
              }
            },
          }, {
            id: "probe.isolate",
            bind: "ctrl+o",
            run() {
              setCloseResults(Object.fromEntries(context.ui.tabs.list()
                .filter((tab) => !tab.active)
                .map((tab) => [tab.sessionID, context.ui.tabs.close(tab.sessionID)])));
              setIsolateRequests((count) => count + 1);
            },
          }],
        }));
        createEffect(() => {
          const snapshot = JSON.stringify({
            isolateRequests: isolateRequests(),
            closeResults: closeResults(),
            enabled: context.ui.tabs.enabled(),
            tabs: context.ui.tabs.list().map((tab) => ({
              ...tab,
              projectID: context.data.session.get(tab.sessionID)?.projectID,
            })),
            route: context.ui.router.current(),
          });
          writes = writes.then(async () => {
            await Bun.write(path, snapshot);
            if (context.options.history) {
              await appendFile(`${path}.history.jsonl`, `${snapshot}\n`);
            }
          });
        });
        return null;
      },
    });
  },
});
