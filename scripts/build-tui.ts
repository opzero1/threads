import solid from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["tui.ts"],
  outdir: ".",
  target: "bun",
  packages: "external",
  plugins: [solid],
});

if (!result.success) throw new AggregateError(result.logs, "TUI build failed");
