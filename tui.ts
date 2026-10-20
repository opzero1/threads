import { Plugin } from "@opencode/plugin/tui";
import { getComponentCatalogue } from "@opentui/solid/components";
import { createEffect, createSignal } from "solid-js";
import { activity } from "./src/activity";
import { workflowUI } from "./src/workflow-ui";
import { RGBA } from "@opentui/core";

export default Plugin.define({
  id: "op-threads",
  setup(ctx) {
    const workflows = workflowUI(ctx, RGBA.fromHex("#808080"));
    const disposeActivity = activity(
      ctx,
      RGBA,
      { createEffect, createSignal },
      getComponentCatalogue().spinner !== undefined,
      { workflows: workflows.active, openWorkflows: workflows.open },
    );
    return () => {
      workflows.dispose();
      disposeActivity();
    };
  },
});
