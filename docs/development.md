# Development

This page is for working on Threads itself: setting up a checkout, running the checks, and publishing a release.

## Set up

1. Clone the repository and run `bun install`.
2. Point the server plugin entry at the clone's absolute path. Update any explicit terminal entry too. See [use a local checkout](configuration.md#use-a-local-checkout).
3. Restart OpenCode.

A local checkout loads `tui.ts` directly. The npm package ships a compiled `tui.js` instead.

Editing a loaded local plugin can unload and reload it without restarting the server. Threads records active workflows as interrupted during cleanup. To keep development edits from interrupting everyday work, install a verified tarball under a separate `node_modules` directory and point your global configuration there.

## Find your way around

| Path | Contents |
| --- | --- |
| `index.ts` | Server entry point: tools, RPC, and plugin options. |
| `tui.ts` | Terminal entry point. |
| `src/threads.ts` | Worker creation, retries, limits, reports, and hiding. |
| `src/permissions.ts`, `src/external-access.ts` | Worker permission rules and `paths` grants. |
| `src/rpc.ts` | `ThreadsRpc`, `WorkerView`, and the report schema. |
| `src/activity.ts`, `src/activity-model.ts` | Threads list and footer state. |
| `src/activity-footer.tsx`, `src/activity-theme.ts` | Footer indicator and theme colors. |
| `src/idle.ts` | Keeps idle terminals from sending requests. |
| `src/workflows.ts`, `src/workflow-*.ts` | Workflow tools, runner, journal, confined runtime, and saved scripts. |
| `src/workflow-ui.tsx` | Workflow navigator and run panel. |
| `skills/` | The `workflow-authoring` skill, which the plugin loads, and the optional `managed-sessions` skill. |
| `scripts/` | Native verification suites and their fixtures. |
| `test/` | Unit tests. |

## Run the checks

```sh
bun run typecheck
bun test
```

The native suites start an isolated OpenCode server with a deterministic local model. They need OpenCode V2, Python, and `uv`. They make no paid model calls.

| Command | What it checks |
| --- | --- |
| `bun run verify:live` | Worker tools, durable messages, permissions, limits, deleted workers, restarts, the footer indicator, and which tools are native or reached through Code Mode `search` and `execute`. |
| `bun run verify:footer` | The footer indicator, the Threads list, its row menu, tab closing, `/threads`, and restart. |
| `bun run verify:roles` | Agent profiles: system prompts, models, delegation, read-only work, reports, and retries. |
| `bun run verify:workflows` | Workflow pipelines, retries, roles, checkpoints, saved scripts, worktrees, restarts, the navigator, the footer's workflow count, and the sidebar section. |
| `bun run verify:workflow-regressions` | Known workflow engine defects stay fixed. |
| `bun run verify:workflow-runtime` | Script cancellation and thread cleanup in the confined runtime. |
| `bun run verify:workflow-capacity` | Concurrency, total steps, controls, deadlines, and cleanup under load. |
| `bun run verify:workflow-cleanup` | Worktree removal when runs end, kept worktrees and their reasons, a worker that is still running, `workflows_prune` dry runs and apply, and the edit permission it needs. |
| `python3 scripts/verify-heartbeat.py [--target <package-directory>] [--scenario workflow\|outage\|ipv6]` | One package's plugin and heartbeat runner: workflow holds, durable reminders, and LaunchAgent cleanup; an installed runner that survives an OpenCode outage and reconnects; and the same over an unchanged IPv6 registration. Runs every scenario by default. |
| `python3 scripts/verify-interrupt-followups.py [--scenario threads\|native]` | An interrupt holds the follow-ups queued behind the stopped run: no later coordinator turn or list wakes the worker, `threads_interrupt` names them, and the next `threads_send` resumes them. A native interrupt from the worker's tab also stays in effect. |
| `python3 scripts/verify-workflow-lifecycle.py` | Task Location invalidation, isolated restart, plugin reload, and inspection-only interruption reminders. |
| `bun run verify:package-ui <package>` | A packed or published package, installed under `node_modules`, in a clean terminal. |

Run the checks that match your change. Evidence goes to `.audit/`, which git ignores.

The fixture model calls Code Mode tools through `execute`. `scripts/fixture.py` maps each of those tool IDs to its Code Mode path and reports an inner call's failure as a tool error, so the suites keep using tool IDs.

Use `THREADS_ARTIFACT_DIR=<new-directory>` to retain separate footer and workflow attempts.

Set `OPENCODE_SOURCE` to an OpenCode V2 source checkout to run the permission-oracle tests against its native evaluator. Those tests skip when the variable is absent.

## Keep the published package loadable

- The published terminal entry point is Solid-compiled `tui.js`, built by `prepack`. Keep OpenCode, OpenTUI, and Solid imports external. Root `tui.ts` must not appear in the tarball.
- OpenCode's Solid transform skips `node_modules`, so raw TSX there loses its reactive bindings. Only an install under `node_modules` shows that failure. A source checkout, an extracted folder, or the test-only terminal probe can hide it.
- `verify:package-ui` installs the package under `node_modules` and tests keyboard input as well as rendering. Rendering alone is not proof.

## Release a version

1. Run the typecheck, the unit tests, and the native suites that match the change.
2. Pack the release:

   ```sh
   npm pack --json --pack-destination <existing-artifact-directory>
   ```

   Keep the manifest and integrity hash. Check that the tarball includes `tui.js` and excludes root `tui.ts`.

3. Run `bun run verify:package-ui /absolute/path/to/package.tgz`. All ten checks must pass:
   - The idle footer is empty.
   - `ctrl+x j` opens the Threads list with only the current conversation. Search reacts to typing, and **Esc** closes the list.
   - `/activities` opens the same list.
   - A running worker shows the footer indicator without opening a tab.
   - A finished worker's row menu dismisses and restores it.
   - With that worker focused, the list shows its coordinator's thread, and **Open** returns to the main conversation.
   - `/workflows` opens the navigator.
   - On the home screen, the list shortcut shows its open-a-conversation notice.
   - A completed workflow's result panel opens and closes.
   - Options left over from earlier versions add no sidebar and no automatic worker tab.
4. Commit the source you packed and tag it `v<version>`. Pack from a clean working tree, so that the tag matches the package.
5. Publish that exact tarball. If any packed content changes, pack again and repeat steps 3 and 4.
6. Wait until npm serves the new version. Download its tarball and compare its integrity with the verified one. `npm publish` can succeed before the registry serves the version.
7. Run `bun run verify:package-ui @op1/threads@<version>` against the registry package.
8. Push the commit and the tag to `main`.
9. Update your own installation. Keep its existing options. Confirm that the server reports the new version, then check the footer, the Threads list, and their commands in a live terminal.

Keep the manifest, the integrity comparison, the command results, and the terminal evidence together under `.audit/release-<version>/`.

## When a release misbehaves

| You see | Check next |
| --- | --- |
| `ctrl+x j` and `/activities` both do nothing | Terminal plugin loading and the `role=cli` logs. Server activation doesn't prove the terminal plugin loaded. An idle footer is empty by design, so it proves nothing. |
| `Cannot find package 'react'` from a plugin TSX file | The installed package's entry point. Local JSX configuration and the terminal probe can hide missing Solid compilation. |
| The list renders, but its shortcut hint is missing or **Esc** does nothing | That the installed entry point reaches Solid-compiled code. A JSX import directive alone doesn't supply Solid's bindings. |
| The server fails with `No matching version found` | npm propagation. A successful publish doesn't mean the version is installable yet. |

Reopening a terminal fixes a reload problem only after the installed package has passed a clean-start check.

## Design records

- [Verification history](verification-history.md): what the checks behind each release measured, including workflow capacity.
- [Decision log](dynamic-workflows-decisions.tsv): how the workflow engine was designed and verified.
