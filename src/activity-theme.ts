import type { ResolvedTheme } from "@opencode/theme/tui";

type Color = ResolvedTheme["text"]["base"];
type ColorToken =
  | { readonly base: Color | undefined }
  | { readonly default: Color | undefined };
type MutedToken =
  | { readonly muted: Color | undefined }
  | { readonly subdued: Color | undefined };

export function themeColor(token: ColorToken, fallback: Color) {
  return ("base" in token ? token.base : token.default) ?? fallback;
}

export function themeMuted(token: MutedToken, fallback: Color) {
  return ("muted" in token ? token.muted : token.subdued) ?? fallback;
}

function luminance(color: Color) {
  const linear = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(color.r) +
    0.7152 * linear(color.g) +
    0.0722 * linear(color.b)
  );
}

export function themeHue(
  hue: Partial<ResolvedTheme["hue"]["accent"]> | undefined,
  foreground: Color,
  background: Color,
) {
  const target = luminance(foreground);
  let selected = foreground;
  let distance = Infinity;
  for (const color of Object.values(hue ?? {})) {
    if (!color) continue;
    const delta = Math.abs(luminance(color) - target);
    if (delta >= distance) continue;
    selected = color;
    distance = delta;
  }
  const light = luminance(selected);
  const base = luminance(background);
  const contrast =
    (Math.max(light, base) + 0.05) / (Math.min(light, base) + 0.05);
  return contrast >= 4.5 ? selected : foreground;
}
