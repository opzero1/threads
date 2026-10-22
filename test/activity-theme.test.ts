import { expect, test } from "bun:test";
import { Renderable, RGBA, TextRenderable, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { themeColor } from "../src/activity-theme";

const fallback = RGBA.fromHex("#808080");
const foreground = RGBA.fromHex("#00ffff");

// Stands in for OpenCode 2.1's unpublished `spinner`: a color setter that requests a render, and drawText per glyph.
class HostSpinner extends Renderable {
  #glyph: string;
  #color: RGBA;
  constructor(ctx: RenderContext, glyph: string, color: RGBA) {
    super(ctx, { width: 1, height: 1 });
    this.#glyph = glyph;
    this.#color = color;
  }
  set color(value: RGBA) {
    this.#color = value;
    this.requestRender();
  }
  protected override renderSelf(buffer: OptimizedBuffer) {
    buffer.drawText(this.#glyph, this.screenX, this.screenY, this.#color);
  }
}

test.each([
  ["current theme", { base: foreground }, foreground],
  ["legacy theme", { default: foreground }, foreground],
  ["missing current color", { base: undefined }, fallback],
  ["missing legacy color", { default: undefined }, fallback],
] as const)("spinner preserves whole-frame painting with %s", async (_, token, expected) => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 30,
    height: 4,
  });
  try {
    let frames = 0;
    renderer.on("frame", () => frames++);
    expect(themeColor(token, fallback)).toBe(expected);
    const spinner = new HostSpinner(renderer, "⠋", themeColor(token, fallback));
    const text = new TextRenderable(renderer, { content: "before" });
    renderer.root.add(spinner);
    renderer.root.add(text);
    await renderOnce();
    expect(frames).toBe(1);
    expect(captureCharFrame()).toContain("⠋");
    spinner.color = themeColor(token, fallback);
    text.content = "responsive";
    await renderOnce();
    expect(frames).toBe(2);
    expect(captureCharFrame()).toContain("⠋");
    expect(captureCharFrame()).toContain("responsive");
  } finally {
    renderer.destroy();
  }
});
