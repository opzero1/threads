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
