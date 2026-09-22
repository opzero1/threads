import type { BoxRenderable, Renderable } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";

// Compatibility boundary: OpenCode 2.0.7 has no public left-tab-rail slot.
export function activityRail(
  ctx: Plugin.Context,
  core: Pick<
    typeof import("@opentui/core"),
    "BoxRenderable" | "ScrollBoxRenderable"
  >,
  mount: (rail: BoxRenderable) => () => void,
) {
  const { BoxRenderable, ScrollBoxRenderable } = core;
  let owned:
    | {
        rail: BoxRenderable;
        content: BoxRenderable;
        restore: Map<Renderable, boolean>;
        cleanup: () => void;
      }
    | undefined;
  let enabled = true;
  let dirty = true;
  let geometry = "";
  const detach = () => {
    if (!owned) return;
    owned.cleanup();
    if (!owned.content.isDestroyed) owned.content.destroyRecursively();
    for (const [child, visible] of owned.restore)
      if (!child.isDestroyed) child.visible = visible;
    owned = undefined;
  };
  const find = () => {
    const matches: BoxRenderable[] = [];
    const queue: { node: Renderable; depth: number }[] = [
      { node: ctx.renderer.root, depth: 0 },
    ];
    let count = 0;
    while (queue.length && count++ < 128) {
      const entry = queue.shift();
      if (!entry) break;
      const children = entry.node.getChildren();
      for (const child of children) {
        if (
          child instanceof BoxRenderable &&
          child.visible &&
          child.screenX === 0 &&
          child.screenY === 0 &&
          child.width >= 24 &&
          child.width <= 60 &&
          child.height === ctx.renderer.height &&
          child
            .getChildren()
            .some((node) => node instanceof ScrollBoxRenderable) &&
          children.filter(
            (sibling) =>
              sibling !== child &&
              sibling.screenX === child.width &&
              sibling.screenY === 0 &&
              sibling.height === child.height &&
              sibling.width >= 60,
          ).length === 1
        )
          matches.push(child);
        if (entry.depth < 4)
          queue.push({ node: child, depth: entry.depth + 1 });
      }
    }
    return queue.length === 0 && matches.length === 1 ? matches[0] : undefined;
  };
  const frame = () => {
    if (owned?.rail.isDestroyed || owned?.content.isDestroyed) {
      detach();
      dirty = true;
    }
    const current = `${ctx.renderer.width}:${ctx.renderer.height}:${owned?.rail.width}:${owned?.rail.height}`;
    if (current !== geometry) {
      geometry = current;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    const rail = enabled && ctx.ui.tabs.enabled() ? find() : undefined;
    if (owned?.rail !== rail) detach();
    if (!rail) return;
    if (!owned) {
      const content = new BoxRenderable(ctx.renderer, {
        id: "op-threads-activity",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        paddingLeft: 1,
        paddingRight: 2,
        flexDirection: "column",
        onMouseDown: (event) => event.stopPropagation(),
        onMouseUp: (event) => event.stopPropagation(),
      });
      rail.add(content);
      owned = { rail, content, restore: new Map(), cleanup: mount(content) };
    }
    for (const child of rail.getChildren()) {
      if (child === owned.content) continue;
      if (!owned.restore.has(child)) owned.restore.set(child, child.visible);
      child.visible = false;
    }
    for (const child of owned.restore.keys())
      if (child.isDestroyed) owned.restore.delete(child);
  };
  const invalidate = () => {
    dirty = true;
    ctx.renderer.requestRender();
  };
  const beforeFrame = async () => frame();
  ctx.renderer.setFrameCallback(beforeFrame);
  ctx.renderer.on("resize", invalidate);
  invalidate();
  return {
    invalidate,
    enabled: () => enabled,
    mounted: () =>
      Boolean(owned && !owned.rail.isDestroyed && !owned.content.isDestroyed),
    toggle(value = !enabled) {
      enabled = value;
      if (!enabled) detach();
      invalidate();
    },
    dispose() {
      ctx.renderer.removeFrameCallback(beforeFrame);
      ctx.renderer.off("resize", invalidate);
      detach();
    },
  };
}
