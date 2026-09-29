import { Plugin } from "@opencode/plugin/tui";
import { getComponentCatalogue } from "@opentui/solid/components";
import { createEffect } from "solid-js";
import { z } from "zod";
import type { Renderable } from "@opentui/core";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { writeFileSync } from "node:fs";

export default Plugin.define({
  id: "op-threads-tui-probe",
  async setup(context) {
    const path = context.options.path;
    if (typeof path !== "string")
      throw new Error("Probe output path is required");
    const openSessionIDs = z
      .array(z.string())
      .default([])
      .parse(context.options.openSessionIDs);
    const [seeded, updateSeeded] = context.storage.memory("seeded", {
      initial: { done: false },
    });
    if (!seeded.done) {
      for (const sessionID of openSessionIDs) {
        await context.data.session.sync(sessionID);
        context.ui.tabs.open(sessionID);
      }
      updateSeeded((draft) => {
        draft.done = true;
      });
    }
    let writes = Promise.resolve();
    const describe = (node: Renderable, depth = 0): unknown => ({
      id: node.id,
      num: node.num,
      fg: node instanceof TextRenderable ? node.fg.toInts() : undefined,
      bg: node instanceof BoxRenderable ? node.backgroundColor.toInts() : undefined,
      text: node instanceof TextRenderable ? node.plainText : node instanceof InputRenderable ? node.value : undefined,
      x: node.screenX,
      y: node.screenY,
      width: node.width,
      height: node.height,
      visible: node.visible,
      box: node instanceof BoxRenderable,
      scroll: node instanceof ScrollBoxRenderable,
      nativeSpinner: Boolean(
        getComponentCatalogue().spinner &&
          node instanceof getComponentCatalogue().spinner,
      ),
      children:
        depth < 14
          ? node.getChildren().map((child) => describe(child, depth + 1))
          : [],
    });
    const treeTimer = context.options.tree
      ? setInterval(() => {
          writeFileSync(
            `${path}.tree.json`,
            JSON.stringify({
              app: context.app,
              route: context.ui.router.current(),
              tree: describe(context.renderer.root),
            }),
          );
        }, 100)
      : undefined;
    const removeSlot = context.ui.slot({
      append: "app",
      render() {
        createEffect(() => {
          const snapshot = JSON.stringify({
            enabled: context.ui.tabs.enabled(),
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
    return () => {
      clearInterval(treeTimer);
      removeSlot();
    };
  },
});
