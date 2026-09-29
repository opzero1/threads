# Agent notes

Read [the release procedure](docs/development.md#release-a-version) and [package loading rules](docs/development.md#keep-the-published-package-loadable) before you change package entry points, publish, or switch a user's plugin installation.

- The published terminal entry point is Solid-compiled `tui.js`. Keep OpenCode, OpenTUI, and Solid runtime imports external. Root `tui.ts` is for local development and must not appear in the npm tarball.
- Verify the exact npm tarball with `bun run verify:package-ui /absolute/path/to/package.tgz`. A source checkout, an extracted folder, or the terminal probe can hide an installed-package failure.
- Commit and tag the packed source before you publish it. Publish the verified tarball and keep its integrity hash. Packing again creates a new artifact that needs verification.
- Before you change a working global installation, verify the published version with `bun run verify:package-ui @op1/threads@<version>`. After the switch, confirm server activation and the live terminal separately.
- Keep the user's plugin options, agent profiles, and saved workflow records during installation changes.
- Keep the README short. Put detail in `docs/`, and record user-visible changes in `CHANGELOG.md`.
