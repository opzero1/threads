import { Plugin } from "@opencode/plugin/tui";
import { getComponentCatalogue } from "@opentui/solid/components";
import { appendFile } from "node:fs/promises";
import { createEffect, createSignal } from "solid-js";
import { z } from "zod";
import type { Renderable } from "@opentui/core";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, RGBA } from "@opentui/core";
import { appendFileSync, writeFileSync } from "node:fs";
import { themeColor, themeHue, themeMuted } from "../../src/activity-theme";

export default Plugin.define({
  id: "op-threads-tui-probe",
  async setup(context) {
    const fallbackColor = RGBA.fromHex("#808080");
    const configuredPath = context.options.path;
    if (typeof configuredPath !== "string")
      throw new Error("Probe output path is required");
    const path = context.options.perProcess
      ? `${configuredPath}.${process.pid}.json`
      : configuredPath;
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
    const [isolateRequests, setIsolateRequests] = createSignal(0);
    const [closeResults, setCloseResults] = createSignal<
      Record<string, boolean>
    >({});
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
          const foreground = themeColor(context.theme.text, fallbackColor);
          const background =
            context.theme.background.raised?.base ??
            themeColor(context.theme.background, fallbackColor);
          writeFileSync(
            `${path}.tree.json`,
            JSON.stringify({
              app: context.app,
              themeMode: context.themeMode,
              themeText: themeColor(context.theme.text, fallbackColor).toInts(),
              themeColors: Object.fromEntries(
                Object.entries({
                  default: themeColor(context.theme.text, fallbackColor),
                  subdued: themeMuted(context.theme.text, fallbackColor),
                  accent:
                    themeHue(context.theme.hue?.accent, foreground, background),
                  workers:
                    themeHue(context.theme.hue?.purple, foreground, background),
                  running: themeColor(context.theme.text.feedback.info, fallbackColor),
                  warning: themeColor(context.theme.text.feedback.warning, fallbackColor),
                  error: themeColor(context.theme.text.feedback.error, fallbackColor),
                }).map(([name, color]) => [name, color.toInts()]),
              ),
              route: context.ui.router.current(),
              tree: describe(context.renderer.root),
            }),
          );
        }, 100)
      : undefined;
    let mountToggle = 0;
    const captureMount: Parameters<
      typeof context.renderer.addPostProcessFn
    >[0] = (buffer) => {
      if (!mountToggle) return;
      const header = new TextDecoder()
        .decode(buffer.getRealCharBytes(true))
        .split("\n")[0]
        ?.slice(0, 42)
        .trim();
      appendFileSync(
        `${path}.mount.jsonl`,
        JSON.stringify({ toggle: mountToggle, header }) + "\n",
      );
    };
    if (context.options.mounts)
      context.renderer.addPostProcessFn(captureMount);
    const removeSlot = context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          commands: [
            {
              id: "probe.activity.toggle",
              bind: "f6",
              enabled: () => context.options.mounts === true,
              run() {
                mountToggle++;
                context.keymap.dispatch("threads.activity.toggle");
              },
            },
            {
              id: "probe.arrange",
              bind: "ctrl+g",
              run() {
                for (const [index, sessionID] of openSessionIDs.entries()) {
                  context.ui.tabs.move(sessionID, index);
                }
              },
            },
            {
              id: "probe.isolate",
              bind: "ctrl+o",
              run() {
                setCloseResults(
                  Object.fromEntries(
                    context.ui.tabs
                      .list()
                      .filter((tab) => !tab.active)
                      .map((tab) => [
                        tab.sessionID,
                        context.ui.tabs.close(tab.sessionID),
                      ]),
                  ),
                );
                setIsolateRequests((count) => count + 1);
              },
            },
          ],
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
    return () => {
      clearInterval(treeTimer);
      context.renderer.removePostProcessFn(captureMount);
      removeSlot();
    };
  },
});
