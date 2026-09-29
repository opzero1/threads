import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { SpinnerRenderable } from "opentui-spinner";
import { themeColor } from "../src/activity-theme";

const fallback = RGBA.fromHex("#808080");
const foreground = RGBA.fromHex("#00ffff");

test.each([
  ["current theme", { base: foreground }],
  ["legacy theme", { default: foreground }],
  ["missing current color", { base: undefined }],
  ["missing legacy color", { default: undefined }],
] as const)("spinner preserves whole-frame painting with %s", async (_, token) => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 30,
    height: 4,
  });
  try {
    let frames = 0;
    renderer.on("frame", () => frames++);
    const spinner = new SpinnerRenderable(renderer, {
      frames: ["⠋"],
      autoplay: false,
      color: themeColor(token, fallback),
    });
    const text = new TextRenderable(renderer, { content: "before" });
    renderer.root.add(spinner);
    renderer.root.add(text);
    await renderOnce();
    expect(frames).toBe(1);
    spinner.color = themeColor(token, fallback);
    text.content = "responsive";
    await renderOnce();
    expect(frames).toBe(2);
    expect(captureCharFrame()).toContain("responsive");
  } finally {
    renderer.destroy();
  }
});
