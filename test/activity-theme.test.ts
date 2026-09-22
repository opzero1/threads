import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { SpinnerRenderable } from "opentui-spinner";
import { themeColor, themeHue } from "../src/activity-theme";

const fallback = RGBA.fromHex("#808080");
const foreground = RGBA.fromHex("#00ffff");

const darkHue = RGBA.fromHex("#1e40af");
const lightHue = RGBA.fromHex("#bfdbfe");
test.each([
  ["legacy light", { 200: lightHue, 800: darkHue }, "#1a1a1a", "#fafafa", darkHue],
  ["current light", { 200: darkHue, 800: lightHue }, "#1a1a1a", "#fafafa", darkHue],
  ["dark", { 200: lightHue, 800: darkHue }, "#eeeeee", "#141414", lightHue],
  ["reversed dark", { 200: darkHue, 800: lightHue }, "#eeeeee", "#141414", lightHue],
] as const)("hue foreground stays readable with %s ramps", (_, hue, text, background, expected) => {
  expect(themeHue(hue, RGBA.fromHex(text), RGBA.fromHex(background))).toBe(expected);
});

test("missing hue shades preserve a usable foreground color", () => {
  const background = RGBA.fromHex("#141414");
  expect(themeHue(undefined, foreground, background)).toBe(foreground);
  expect(themeHue({}, foreground, background)).toBe(foreground);
  expect(themeHue({ 200: lightHue }, foreground, background)).toBe(lightHue);
  expect(themeHue({ 800: lightHue }, foreground, background)).toBe(lightHue);
});

test("foreground hue selection considers the full ramp rather than fixed indices", () => {
  const darkerHue = RGBA.fromHex("#172554");
  expect(themeHue({ 100: darkerHue, 200: darkHue, 800: lightHue }, RGBA.fromHex("#1a1a1a"), RGBA.fromHex("#fafafa")))
    .toBe(darkerHue);
});

test("a low-contrast hue uses the theme foreground", () => {
  const text = RGBA.fromHex("#1a1a1a");
  expect(themeHue({ 100: RGBA.fromHex("#d68c27"), 700: lightHue }, text, RGBA.fromHex("#fafafa")))
    .toBe(text);
});

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
