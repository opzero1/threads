# Dynamic workflow verification

The hardening pass targets the seven defects reproduced against `5858de1`, plus storage and timeout races found during integration. The original blanket readiness claim is superseded by these checks and the limits below.

Current verification uses OpenCode `2.0.14`, Bun `1.4.0`, and published `@opencode/codemode` `2.0.12`. Earlier baseline and failing-before evidence used OpenCode `2.0.12`.

## Release procedure

1. Run typecheck, unit tests, and the native checks appropriate to the change.
2. Run `npm pack --json --pack-destination <existing-artifact-directory>`. Keep its manifest and integrity hash. The `prepack` hook must build `tui.js`; verify that the tarball includes it and excludes root `tui.ts`.
3. Run `bun run verify:package-ui /absolute/path/to/package.tgz`. This installs the artifact under `node_modules`, without a TUI probe or project JSX configuration. Require all ten checks:
   - The idle footer is empty.
   - `ctrl+x j` opens the Threads list with only the current conversation. Its search reacts to typing, and Escape closes it.
   - `/activities` opens the same list.
   - A running worker shows the footer indicator without opening a tab.
   - `ctrl+d` dismisses and restores a finished worker without closing the list.
   - With that worker focused, the list shows its coordinator's thread, and Enter returns to the main conversation.
   - `/workflows` opens the navigator.
   - On the home screen, the list shows its open-a-conversation message.
   - A completed workflow's result panel opens and closes.
   - Leftover `activity: "sidebar"` and `workerTabs: "auto"` options add no Activity rail and no automatic worker tab, while the footer and the list still work.
4. Publish that exact tarball. If any packed content changes, repack and repeat the artifact check.
5. Wait for npm's package index to expose the new version. Download its tarball and compare integrity with the verified artifact. A successful `npm publish` can precede registry availability.
6. Run `bun run verify:package-ui @op1/threads@<version>` against the registry package before switching a working global installation.
7. Preserve existing options when updating the global plugin entry. Confirm the server reports the intended version as active, then verify the footer indicator, the Threads list, and their commands in the live TUI. Record those observations separately.

`prepack` builds the UI automatically. The clean-install checks are explicit release gates; publishing does not run them automatically. Keep the manifest, integrity comparison, command results, and UI evidence together under `.audit/release-<version>/`.

### Early failure signals

| Observation | Next check |
| --- | --- |
| `ctrl+x j` and `/activities` both do nothing | Inspect TUI plugin loading and `role=cli` logs. Server activation alone does not establish TUI activation. An idle footer is empty by design, so it proves nothing on its own. |
| `Cannot find package 'react'` from a plugin TSX file | Check the installed package entrypoint. Local JSX configuration and probe-assisted tests can hide missing Solid compilation. |
| The Threads list or picker renders, but its shortcut hint is missing or Escape does nothing | Check that the installed entrypoint reaches Solid-compiled code. A JSX import directive alone does not supply Solid's reactive bindings. |
| Server load fails with `No matching version found` | Check npm propagation and the resolver's view of the version before changing UI settings. Publication acceptance is not installation readiness. |

Reopening a TUI only addresses a reload problem after the installed package has passed a clean-start check. Do not recommend it as a confirmed fix based on server state or probe-assisted rendering alone.

## Version 0.2.6 thread-only list

Version 0.2.6 removes the Activity sidebar, pins, automatic worker tabs, native tab grouping, and saved-title cleanup. The `activity` and `workerTabs` options are ignored, including the legacy `"sidebar"` and `"auto"` values. OpenCode's native tab rail always shows, in OpenCode's own order. The terminal opens a worker's tab only when you choose that worker in the Threads list. `/threads` restores hidden and dismissed workers into the list without opening tabs. Saved titles keep any `[Main] ` or `[Worker] ` prefix; the list omits it from managed rows and from its header.

`ctrl+x j`, `/activities`, and `/threads` open the Threads list for the current conversation's thread: the main conversation, which is the coordinator when a worker is focused, and that coordinator's managed workers. Rows group as needs attention, running, main, finished, and closed. On the home screen, the list shows "Open a conversation to see its workers". This replaces the 0.2.5 list scope, pins, sidebar option, and automatic worker tabs described below. Dismissed and list-opened storage keep their keys. Saved pins, collapsed sections, and title-cleanup markers are no longer read.

### Checks

On OpenCode 2.0.18, typecheck and 150 unit tests passed after removing the folder-subtitle helper and its two obsolete tests. `verify:footer` passed 25 checks and `verify:package-ui` passed 10 on the row-layout tarball. The earlier 0.2.6 verification passed `verify:live` with 28 checks and `verify:workflows` with 29. `verify:activity`, `verify:tabs`, and `verify:idle-tabs` were removed with the sidebar and tab grouping.

The row-layout check reproduced the old title/subtitle overlap and then verified the exact replacement tarball at 80, 100, and 120 columns, with 23 layout and keyboard checks at each width. Main titles use the available row width without folder or role suffixes. Running, needs-input, failed, and closed workers keep their status visible with a two-cell gap. A live TUI check confirmed the main-row layout after installation.

The release check also exposed a footer/list scope mismatch: an unrelated conversation could show another coordinator's worker count while its own list contained only the main row. The footer now uses the same coordinator identity as the list, including when a worker tab is focused. The home-screen footer continues to summarize all known workers.

The `verify:footer` fixture adds a second conversation in the TUI's folder with its own worker, and an open tab for a conversation in another folder. The 0.2.5 list included both. The suite requires the list to omit them while idle, while workers run or wait for input, and while a worker is focused. It also checks the header without the role prefix, the saved `[Main] ` title that stays unchanged, the home-screen message, and that `ctrl+f` no longer pins. Two list checks moved from `verify:activity`: a dismissed worker stays under Closed after a TUI restart until `/threads` restores it, and deleting a worker's session removes its row from the open list. Another check covers the remaining tab-closing rule: a hidden worker's tab, opened after its report, stays open while focused and closes once focus moves away.

The suite restarts the TUI with leftover `activity: "sidebar"` and `workerTabs: "auto"` options while a worker runs. Version 0.2.5 would open that worker's tab at startup. Version 0.2.6 opens none and adds no Activity rail. Every later check runs with those options, including one for a newly spawned worker that must not get a tab. Neither option changes 0.2.6 behavior, so no signal shows that the plugin received them. An earlier run on the same OpenCode build, against a source that still honored `workerTabs: "auto"`, showed that the TUI applies options from this `cli.json` entry: it opened the worker's tab. `verify:package-ui` starts its second TUI with the same options.

## Version 0.2.5 footer indicator and Threads list

Threads no longer adds a sidebar or worker tabs by default. The terminal claims `prompt.footer.status` and `home.footer.status` and renders an indicator only while a known worker runs or waits for input, or a workflow of the current conversation progresses. It shows a spinner with the running worker and workflow counts, plus `? N needs input` in the warning color. `ctrl+x j`, `/activities`, and `/threads` open the Threads list, a dialog that covers the current coordinator, root sessions in the TUI's folder, open tabs, pins, and their managed workers. The dialog groups rows as needs attention, running, pinned, finished, recent, and closed, and applies the Activity pin, dismiss, and hidden rules. `activity: "sidebar"` keeps the Activity sidebar. `workerTabs: "auto"` keeps automatic tabs for running workers. Tabs that the list opens for unreported workers close after the worker reports, unless they are focused, running, or waiting for input. Existing pin, dismissed, section, and stack storage keeps its keys and shape; the only new key is `list-opened-workers`.

The TUI's own folder is `ctx.data.location.default()`. `ctx.location` follows the focused session, so after focusing a worker tab it names the worker's folder. The list and the list-opened record use the default Location.

### Loaded Locations

Isolated runs on OpenCode 2.0.16 compared the new defaults with `fix/idle-locations` (9abdba3) alone. The fixture has a coordinator tab and two ordinary tabs, with the TUI in the service HOME and `--auto`. The coordinator spawns one worker in its own directory, and the worker reports `FAIL`. Counts are `GET /api/debug/location` entries. After each phase every Location was evicted and observed for 30 seconds.

| Build | MCP servers | Idle | Worker running | Worker finished, after eviction | Fresh TUI | Fresh TUI, after eviction |
| --- | --- | --- | --- | --- | --- | --- |
| 9abdba3 | none | 4 | 3, worker tab open | 0 | 5, worker included | 0 |
| footer | none | 4 | 3, no worker tab | 0 | 4, worker excluded | 0 |
| 9abdba3 | 3 per Location | 4 | 5, worker tab open | 5, worker rebooted | 5, worker included | 5, worker rebooted |
| footer | 3 per Location | 4 | 5, no worker tab | 5, worker rebooted | 4, worker excluded | 4, worker not rebooted |

- A fresh TUI loads the worker's Location with 9abdba3, because the finished `FAIL` worker keeps its automatically opened tab and OpenCode prefetches every tab. With MCP servers, that Location starts its three servers again at every TUI start and reboots after each eviction. The footer build opens no worker tab. A fresh TUI makes one request about the worker, `GET /api/session/:id`, which does not load a Location.
- In the TUI session during which the worker ran, both builds end with the worker's Location revalidated when MCP servers are configured. OpenCode's TUI fetches agents, commands, models, providers, skills, and MCP resources for any Location that publishes update events while it is connected, and the server's boot of the worker's Location publishes them. After eviction, the TUI's own `GET /api/mcp/resource` for that Location booted it again within 0.5 seconds. No Threads request was involved, so Threads cannot prevent this. An upstream fix would ignore `mcp.*.changed` for a Location during or after its `location.shutdown`, or revalidate only Locations that a visible view reads.
- While idle after eviction, neither build sent a Threads or workflow RPC.

### Checks

Typecheck and 136 unit tests passed, including 13 for options, footer counts, list grouping, worker states, and reported-tab closing. The native suites passed on OpenCode 2.0.16: `verify:footer` 21 checks, `verify:live` 28, `verify:activity` 36 with the sidebar option, `verify:tabs` 21 with automatic worker tabs, and `verify:idle-tabs` 3. `verify:workflows` passed 29 checks. `verify:live` no longer expects a fresh TUI to recover a running worker's tab; it now requires the footer to show the worker and no worker tab to open. `verify:package-ui` passed all seven checks on the packed tarball.

Four `verify:footer` checks were added after review. They cover a form request, which shows the same `? 1 needs input` marker as a permission request, and the list scope while a worker from another folder is focused. They also cover a reported worker's list-opened tab, which stays open while focused and closes once focus moves away. Temporary source mutations showed that three of them detect regressions: the scope check failed when the list followed `ctx.location`, the form check failed when attention ignored forms, and the focused-tab check failed when the focused guard was dropped.

## Version 0.2.5 idle Locations

On OpenCode 2.0.16 the TUI loads the Location of every open tab when it starts. It also keeps revalidating Locations it has loaded for the rest of its life, even after their tabs close. Evicting a Location with MCP servers publishes `location.shutdown` followed by `mcp.resources.changed` and `mcp.status.changed`. The TUI answers those events with `GET /api/mcp/resource` and `GET /api/command` for that Location, which boots it again within a second. Plain OpenCode does this without Threads.

Threads 0.2.4 added to that set. Its tab reconciler opened a tab for every visible worker of an open coordinator, including finished `FAIL`, `INCONCLUSIVE`, and unreported workers. Its memory-only index repeated this on every TUI start. Three timers also sent located RPCs to the active session's Location while idle: the tab reconciler and workflow panel every 3 seconds, and Activity every 30 seconds. Without MCP servers, those RPCs alone re-woke an evicted Location within 3 seconds.

This section measured automatic worker tabs, which the footer defaults above replace; `workerTabs: "auto"` keeps them. With that option, version 0.2.5 opens worker tabs automatically only while a worker is running or has not started its first execution, and `/threads` still reopens finished workers. The timers send RPCs only while a tab is busy or needs input, a known worker is running, a workflow run can progress, or the workflow panel is open. Session events still refresh immediately. Activity's session list, individual session lookups, snapshot lookups, and input-request reads were measured and do not boot Locations, so they are unchanged.

Isolated sandbox runs with the same fixture compared 0.2.4 and 0.2.5:

- Without MCP servers, 0.2.4 reopened two finished worker tabs and booted their Locations. After every Location was evicted, 0.2.4 re-woke two within 3.2 seconds; 0.2.5 kept all four evicted for 40 seconds and sent no requests.
- With three MCP servers per Location, 0.2.4 loaded six Locations and OpenCode rebooted all six. 0.2.5 never loaded the finished workers' Locations. OpenCode still rebooted the four Locations of the open tabs.
- In both builds, a newly spawned running worker opened its tab without taking focus, Activity showed it under its coordinator, and its `PASS` report hid it again.

`verify:live` now requires a fresh TUI to recover a running worker's tab and to leave finished workers closed. Typecheck, 123 unit tests, `verify:live`, `verify:activity`, `verify:tabs`, `verify:idle-tabs`, and `verify:workflows` passed on OpenCode 2.0.16.

The first independent review returned **INCONCLUSIVE** with no blocking findings, because it could not run commands or read the retained evidence. Its note that the workflow timer polls while any panel is open was checked against OpenCode 2.0.16. `ui.panel.current()` returns only the calling plugin's panel, OpenCode closes a panel when the route leaves its session, and Threads opens only its workflow panel. The exception therefore applies only while the workflow panel is shown. In a sandbox probe, a shown panel refreshed every 3 seconds. After the user left its session, or while another plugin's panel was open, 0.2.5 sent no requests for 30 seconds and every evicted Location stayed evicted. In each of those windows, 0.2.4 sent 23 snapshot RPCs and re-woke two Locations. Session events and deliberate actions still send located RPCs. A run waiting on a checkpoint also keeps the workflow timer active while its owner session is shown, because its other steps can still run.

## Version 0.2.2 compiled TUI

The npm package now ships a Solid-compiled `tui.js`, built by `prepack`, rather than loading TSX at runtime. The host's Solid transform excludes `node_modules`; raw JSX there does not receive the reactive bindings that the picker and workflow panel need. External runtime packages remain imports so OpenCode can supply its own renderer and Solid instance.

The corrected verifier installs the tarball into `node_modules` outside the checkout and removes the test-only TUI probe. Its checks passed on OpenCode 2.0.14:

- Activity renders from the installed package.
- `/activities` registers keyboard shortcuts, pins and unpins the selected conversation, and closes with Escape.
- `/workflows` reports the empty state.
- A native `workflows_start` call completes a script; its result panel renders the phase and returned JSON and closes with Escape.

Typecheck passed. Runtime source logic is unchanged from the 109-test / 407-assertion pass. The release artifacts and failed 0.2.1 baseline are retained under `.audit/release-0.2.2/`.

The registry-installed 0.2.2 package also passed all four checks. Its downloaded tarball matched the verified artifact. The global server activated 0.2.2 with the user's 32/8/8 limits, and a live terminal capture confirmed Activity after the switch.

Precompiled candidates must replace the conventional TUI entrypoint too. Changing only the package export while retaining root `tui.ts` did not test the bundle when the harness passed the installed directory as a local plugin. The final package includes `tui.js` and omits root `tui.ts`.

## Version 0.2.1 packaging correction

This attempted correction was insufficient. The published registry install still failed with the React import error, although the extracted-directory check below passed. Loading from `node_modules` must be tested directly; the verifier now installs a tarball there rather than accepting an extracted directory.

The published 0.2.0 package omitted `tsconfig.json`. In a clean TUI, its TSX modules were compiled with React defaults and failed with `Cannot find package 'react'`. The earlier native suites loaded a test-only TUI probe and did not catch this packaging failure. Their results did not establish that the published terminal entrypoint could load by itself.

Version 0.2.1 included the existing JSX configuration in the npm package. At that point, `verify:package-ui` removed the probe but still accepted an extracted package outside the checkout. The following checks passed without catching the installed-package failure:

- Published 0.2.0 reproduced the React import failure and missing Activity rail.
- The extracted 0.2.1 tarball, with fresh production dependencies, passed Activity rendering, the `/activities` picker, and `/workflows` command registration.
- Typecheck and all 109 unit tests / 407 assertions passed.
- Independent static review returned **PASS WITH NOTES**, with no release-blocking findings. Artifact execution was verified by the release coordinator.

## Version 0.2.0 release verification

The release adds configurable `workflowConcurrency` and `workflowMaxAgents` defaults for new runs. Explicit run values take precedence, and resumed records retain their original limits. The persisted schema defaults remain 3 concurrent agents and 4 total steps.

Release verification passed on OpenCode 2.0.14:

- `bun run typecheck` and all 109 unit tests / 407 assertions.
- 13 native regression cases against the extracted npm package, including configured 8/8 defaults, explicit 2/2 overrides, eight completed steps, and resumed 3/4 limits.
- 27 native workflow/TUI checks and 27 managed-session checks against the extracted package with fresh production dependencies.
- Independent source review: **PASS WITH NOTES**, with no release-blocking findings.

The packed source hash is `3b5b77f200d79164227c3caeb86eeab95f4c1188b8f7d5c1f689296e1022df72`. The package includes both entrypoints, all runtime worker modules, and the authoring skill with its runtime reference. Local release artifacts are in `.audit/release-0.2.0/`.

## Hardening checkpoint checks

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run typecheck` | Pass | Server, runtime, and terminal types |
| `bun test` | 109 tests, 407 assertions pass | Confinement, replay, checkpoint atomicity, journal limits, deadline races, failed-attempt accounting, and existing Threads behavior |
| `bun run verify:workflow-regressions` | 12 cases pass | Original engine defects, CPU-bound deadline, saved and nested execution, composition helpers, and retained-worktree handoff |
| `bun run verify:roles` | 17 checks pass | Configured profiles, inherited restrictions, role admission, and native delegation |
| `bun run verify:live` | 27 checks pass | Managed-worker lifecycle, reports, limits, native tabs, and restart recovery |
| `bun run verify:workflow-runtime` | Pass | 35 CPU-bound interpreter cancellations, stable native thread count, and idle CPU |
| `python3 scripts/verify-workflows-model.py` | Pass | Model-authored workflow, real VERA readers, validated handoffs, and automatic coordinator notification |
| `bun run verify:workflows` | 27 checks pass | Native workflow lifecycle, permissions, hard restart, uncertain writes, fresh navigator snapshots, keyboard step navigation, and terminal controls |
| `bun run verify:workflow-capacity --steps 1000 --timeout 900` | 8 scenarios pass | Eight concurrent workers, 1,000 unique native sessions, owner pool sharing, controls, deadlines, and cleanup |

Native harnesses use real isolated OpenCode services with deterministic local providers. These fixtures prove execution behavior rather than model quality. The separate real-model check uses the installed plugin and configured VERA profiles.

Each workflow, regression, and capacity harness records a hash of `index.ts`, `tui.ts`, `package.json`, and direct TypeScript sources in `src/`. It rejects source changes during its run. Local artifacts are retained under `.audit/` and are gitignored:

- `workflows/evidence.json` and `workflows/tui.screen.txt`
- `workflow-regressions/evidence.json` and `workflow-regressions/evidence.baseline.json`
- `workflow-capacity/evidence.json`
- `runtime-soak/evidence.json`
- `workflow-model/evidence.json`

The commands regenerate the evidence. Raw transcripts and temporary session directories are not published.

The final workflow, regression, and 1,000-step capacity runs all verified source hash `1414fd9d27ead4a1f955f11168917842aaef043a8eec172b7bd73699aaf3e414`.

## Regression and recovery proof

The native regression harness first reproduced six engine failures on the old source. The runtime tests separately reproduced the synchronous deadline failure. All twelve native cases now pass:

1. Queued agents cannot dispatch after the measured token budget is exhausted.
2. Failed attempts count toward that budget.
3. Answering one checkpoint preserves `waiting` when another remains unanswered.
4. Concurrent checkpoint responses replay in their recorded order after restart.
5. An exposed failure remains a failure on replay, preserving the script's fallback branch.
6. A crash after an accepted report requires explicit same-worker resolution.
7. Saved scripts accept new arguments and retain pinned nested source after restart.
8. Composition helpers execute through the native service.
9. Saved commands register and refresh.
10. A fifth nested workflow boundary fails.
11. A writer and verifier use the same retained worktree.
12. A CPU-bound script reaches its deadline while service RPC remains responsive.

The hard-crash fixture appends one line, blocks before its report, and kills the service. After restart, no provider request is allowed until explicit recovery. Resume preserves the uncertain write. A follow-up asks the same worker to inspect and report its existing effect; the final file still has exactly one line.

Checkpoint responses and settlement order are committed atomically. Focused tests reject oversized responses before persistence, allow a smaller retry, and retain a concurrently committed agent settlement. Legacy external journals remain preserved during migration. Payload admission reserves diagnostic space while retaining the 16 MiB hard limit.

The macOS runtime soak starts and cancels 35 CPU-bound interpreters. Native thread count returns from 25 to 25, and the following idle second consumes 2.157 ms of process CPU. The check uses the real CodeMode interpreter inside terminable Bun workers.

## Independent review

Independent review is a release gate. The initial audit rejected unqualified readiness and supplied executable counterexamples. Later review found a constructor-failure capacity leak, checkpoint journal poisoning, insufficient control headroom, and recovery failures that affected healthy sibling runs. Those findings received focused regression tests and fixes.

The final integrated engine/store review returned **PASS WITH NOTES**, with no blocking findings. Its remaining timer-cleanup finding was reproduced and fixed: a full legacy journal now clears the deadline and notifies the owner even when failure persistence also fails. The focused test preserves both original records.

A separate UI reviewer identified the stale navigator snapshot, then returned **PASS WITH NOTES** after the fix. Explicit refreshes are serialized, background requests coalesce, and responses are guarded across owner navigation. The native terminal suite passes all 27 checks. The A→B→A generation guard has source review but no dedicated navigation regression.

Accepted review limits include unsupported selective deletion of journal records, replay-order mismatches waiting until the run deadline, and reliance on a single loaded scheduler implementation. Checkpoint responses appear both in the checkpoint and its settlement entry, so they count twice toward the journal limit. A nearly full run can reject even a small response while preserving the unanswered checkpoint. Passing implementation-worker reports alone are not treated as independent approval.

## Real-model verification

Run `wfr_8eafe136e930d91c0127b44532be49a4` completed through coordinator `ses_f35910071ffe0I7E0NR3Bzfvfk`, using `vera-core`:

- `vera-operator-readonly`, `openai/gpt-5.6-sol#low`, read `src/workflow-types.ts`.
- `vera-engineer-readonly`, `openai/gpt-5.6-sol#medium`, read `src/workflow-rpc.ts`.
- Validated result: `{"limits":{"concurrency":3,"maxAgents":4},"controls":["pause","resume","stop"]}`.

Both worker models matched their profiles and journal records. Their transcripts contain successful reads and accepted results. After the automatic notification, the coordinator inspected the run and delivered a PASS receipt.

## Execution boundaries

- One OpenCode service with one loaded scheduler implementation owns scheduling. Multiple services or duplicate module instances sharing storage are unsupported.
- Interrupted writes require inspection and same-worker resolution. A missing worker does not authorize repeating its effects.
- Scripts, arguments, and nested scripts are immutable within a run. Changes require a new run key.
- Native failures and explicit `FAIL` or `INCONCLUSIVE` reports prevent completion, even when the script catches them.
- Token budgets govern dispatch using reported usage. In-flight work can exceed the threshold; unmeasured usage blocks further budgeted dispatch.
- Old journals without checkpoint settlement order cannot replay answered checkpoints deterministically. They fail with a diagnostic rather than inventing an order.
- Corrupt and exact-limit legacy records retain their evidence and produce owner-visible diagnostics. A full legacy record may require explicit repair or a new run key.
- Selectively deleting a run record while retaining its legacy completion journal is unsupported. Both records belong to the same run identity.
- An inconsistent settlement order can wait until the run deadline. Recovery does not invent missing completions to make the script advance.
- Interpreter termination stops script CPU work. Parent-side host effects remain subject to native interruption and uncertain-write recovery.
- Worktrees remain available for inspection and integration. The coordinator owns the final engineering verdict.

The [capacity findings](workflow-capacity-findings.md) distinguish cumulative sessions, concurrent agents, interpreter calls, and measured operating limits.
