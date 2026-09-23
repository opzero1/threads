# Release verification

Read [the release procedure and packaging failure notes](docs/workflows-verification.md#release-procedure) before changing package entrypoints, publishing, or switching a user's plugin installation.

- The published TUI is Solid-compiled `tui.js`. Keep OpenCode, OpenTUI, and Solid runtime imports external. Root `tui.ts` is for local development and must not appear in the npm tarball.
- Verify the exact npm tarball with `bun run verify:package-ui /absolute/path/to/package.tgz`. A source checkout, extracted directory, or TUI probe can mask an installed-package failure. The verifier must install under `node_modules` and test keyboard interaction as well as rendering.
- Publish the verified tarball and retain its integrity hash. Repacking creates a new artifact that needs verification.
- Before changing a working global installation, verify the published version with `bun run verify:package-ui @op1/threads@<version>`. Confirm server activation and the live TUI separately after switching.
- Preserve the user's plugin options, agent profiles, and saved workflow records during installation changes.
