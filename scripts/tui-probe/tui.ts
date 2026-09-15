import { Plugin } from "@opencode/plugin/tui";
import { createEffect } from "solid-js";

export default Plugin.define({
  id: "op-threads-tui-probe",
  setup(context) {
    const path = context.options.path;
    if (typeof path !== "string")
      throw new Error("Probe output path is required");
    let writes = Promise.resolve();
    return context.ui.slot({
      append: "app",
      render() {
        createEffect(() => {
          const snapshot = JSON.stringify({
            tabs: context.ui.tabs.list(),
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
