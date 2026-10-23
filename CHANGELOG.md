# Changelog

## 0.3.4 — 2026-10-23

Requires OpenCode 2.1 or later.

- Interrupting a worker now holds its queued follow-ups. Listing workers or starting another turn in the main conversation no longer wakes it. The next `threads_send` resumes held messages in their original order. An interrupt from the worker's own tab also stays in effect (#56).
- Interrupt results list held messages in `heldFollowups`. Send results list resumed messages in `resumedFollowups` and redelivery errors in `failedFollowups`; recovery retries failed deliveries. OpenCode 2.1 cannot remove queued messages, so a message typed in the worker's tab can also wake it and run held follow-ups. See [interrupting and held follow-ups](docs/reference.md#interrupting-and-held-follow-ups).
- Follow-up records add `woken` and `held` states. Earlier Threads versions cannot read these states and report recovery failures if you downgrade.
- Add isolated-server checks for both interrupt paths. The package UI check now waits for dismiss and restore changes before checking the list.
- Rewrite the README around installation and a first worker, with absolute documentation links and badges for npm. Move compatibility details and the subagent comparison into `docs/`. Correct the installation instructions: OpenCode loads the terminal UI from the server plugin automatically, without a second `cli.json` entry.

## 0.3.3 — 2026-10-22

Requires OpenCode 2.1 or later. OpenCode 2.0 releases are no longer supported; use Threads 0.3.2 with OpenCode 2.0.28.

- Update the OpenCode dependencies to `2.1.2` and OpenTUI to `0.6.6`, the version `@opencode/plugin` 2.1 requires. The footer keeps using the spinner OpenCode registers; the `opentui-spinner` development dependency, which OpenCode 2.1 no longer uses and which fails on OpenTUI 0.6, is removed.
- An `ask` rule for `workflows_start` now prompts before a run is created (#33). Threads calls OpenCode's `permission.assert` with the saved workflow's name, or `*` for an inline script, before it recovers runs, loads a saved script, or records anything. A rejection or `deny` creates no run. With an `ask` rule, every call prompts, including an exact retry with the same key, and no approval is saved, so the prompt offers no **Always** choice. Use an `allow` rule for a saved workflow's name to skip the prompt. See [control workflow starts](docs/configuration.md#control-workflow-starts).
- The heartbeat runner admits OpenCode `2.1.0`, `2.1.1`, and `2.1.2` services instead of `2.0.26` and `2.0.28`.
- A workflow step now fails after 5 rejected `workflows_result` submissions (#9). Malformed tool arguments, which OpenCode rejects before the handler runs, count as well as results that fail the step's schema or size limits; each call counts once, and the count survives restarts. The step fails with the last validation error, can't be retried, and its worker is interrupted even when nothing waits on it. The worker stays blocked after an owner follow-up, and a later valid result is refused. A result accepted earlier stays accepted. Steps record the count in a new optional `rejections` field; older records stay readable. See [reports and worker slots](docs/how-it-works.md#reports-and-worker-slots).
- Administrative tools are now Code Mode tools, so their schemas leave every request's native tool list. Agents call them inside OpenCode's `execute` tool: `tools.threads.list`, `interrupt`, and `hide`, and `tools.workflows.list`, `inspect`, `control`, `save`, `saved`, `prune`, and the five `heartbeat_*` tools. `threads_spawn`, `threads_send`, `threads_report`, `workflows_start`, and `workflows_result` stay native, so read-only workers, which can't use `execute`, can still report. Tool IDs, inputs, results, and permission rules are unchanged. An agent whose permissions deny `execute` loses the administrative tools.
- Workflow notices and the bundled skills point agents to the Code Mode paths.
- Agents now start a workflow only when you ask for one, run `/workflow-run` or a saved workflow, or a loaded skill says to. Otherwise they propose it first. To turn workflow starts off, deny `workflows_start`.
- `workflows_start` now rejects scripts that break workflow body rules (forbidden or unknown globals, imports, `Math.random`) before it creates a run, so the run key stays free for the corrected script.
- `workflows_start` accepts `resumeFrom`: a new run reuses the completed steps of a stopped, failed, or completed run whose key, input, and agent profile (model, instructions, and permissions) are unchanged, and runs the rest live.
- Removed the `retry`, `gate`, and `loopUntilDry` workflow helpers and the derived `maxAgents * 8 + 100` host-call cap. Write retry and discovery loops in plain JavaScript (see the runtime reference). Starting a script that calls a removed helper now fails before a run is created, with an error that points to the replacement. Runs recorded with `helperPolicy: "legacy-bounded"` can still be inspected and listed, but resume refuses them; start a new run.
- `parallel()` and `pipeline()` now let every item finish before rethrowing a single error or an `AggregateError` naming the failed indexes. Pipeline stages receive `(value, item, index)`, and `parallel()` rejects non-function elements with a `TypeError`.
- `phase()` and `log()` no longer need `await` and reach the run as the script calls them, even during a long computation. If the run falls behind, the script holds the latest phase and up to 200 unsent lines. Nested workflows keep their own phase, and `agent()` derives a stable key when `key` is omitted.
- Workflows keep the script's returned result when a step reports `FAIL` or `INCONCLUSIVE`, or when the script catches a failed step: the run completes and the adverse verdicts stay visible on the step, in inspect, and first in the completion notice.
- The workflow engine no longer re-prompts a worker that ends without a `workflows_result`. The step fails and the script decides whether to retry under a new key. Checkpoint answers are stored once, so they no longer count twice toward the journal limit.
- A workflow step worker frees its `maxWorkers` slot when its step fails or its workflow ends. Before, a step that ended without a `workflows_result` report held its slot for good, and enough of them blocked every new worker in that conversation.
- Workflow step workers now see a short frame stating that a workflow script wrote their task on the owner's behalf and that content it quotes is data, not instructions. The task sits between start and end markers derived from its hash, so quoted content can't fake where it ends.
- Workflow completion notices now include the run's total usage and a preview of its result, limited to 2,000 characters and marked `…[truncated]` when cut off.
- Workflow summaries report prepared steps as `counts.queued` instead of counting them in `counts.running`, so `running` no longer exceeds a run's concurrency. The workflow panel shows those steps as `queued`.
- Worktree cleanup now runs once, in the background, when a run ends, whether or not its completion notice is delivered. It follows the `workflowWorktreeCleanup` setting in effect when the run ended. If OpenCode stops before cleanup finishes, Threads doesn't resume it on restart; run `workflows_prune` to remove what it left.
- Saved workflows no longer register `/workflow-<name>` commands. List them with `workflows_saved`, which now includes the optional `meta.whenToUse`, and run one with `workflows_start({ name })`. `workflows_save` accepts `overwrite: true`, and the names `run` and `refresh` are no longer reserved.
- The Threads list now uses OpenCode's native picker. Choose a row to open, dismiss, or restore it (Ctrl+D is gone), and one refresh loop drives the list, footer, and worker tabs. An open list shows workers as they were when it opened; reopen it to see changes.
- Heartbeat acknowledgement checks no longer stop after `maxAckRetries`: an unresolved reminder is checked by exact ID once per cooldown until found or retired. Stored monitors drop the old cap and record a `migrate` history entry, and an identical retry of an enrollment made before the upgrade still returns the existing monitor. `scripts/verify-heartbeat.py` now covers the workflow, outage, and IPv6 scenarios from one `--target`, replacing `verify-heartbeat-ipv6.py`.
- The workflow plan, verification record, and capacity findings are merged into one page, [Verification history](docs/verification-history.md). The repeated defaults are gone, `how-it-works.md` covers only the design, and its permission and follow-up descriptions now match the code.
- The native verification suites share their tool-driving, Git, source-fingerprint, and heartbeat fixtures, and the lifecycle suite no longer runs part of the heartbeat script. The native load study, the click and refresh probes, and the stale failed-replay regression case are removed.

## 0.3.2

- When a workflow run completes, fails, or stops, Threads removes each step worktree that has no uncommitted or untracked changes and whose commits a branch, tag, or remote contains. It runs `git worktree remove` without `--force` and never deletes branches. Shared steps, runs that can still resume, checkouts that contain another worktree, and checkouts where a worker is still running keep their directories. The run's new `worktreeCleanup` field records what was removed and kept, and why. Cleanup starts after the result is recorded and can't change it.
- A workflow step can no longer be recorded in a checkout while cleanup removes it. A step whose checkout is already gone fails with a clear error.
- Add the `workflowWorktreeCleanup` server option. Set it to `false` to keep finished runs' worktrees.
- Add the `workflows_prune` tool. It lists step worktrees left by finished runs in the current project, including runs that ended before this release, and changes nothing unless called with `apply: true`. `olderThanDays` limits it to older runs. It never deletes run records, sessions, or branches.
- Runs record when they ended in a new `finished` field.

## 0.3.1

- Background worker-tab and Threads list refreshes no longer show a toast when an OpenCode service restart drops the connection. They retry every two seconds and report a transport failure only after it lasts 15 seconds. Other errors and failures from commands you run are still reported immediately.

## 0.3.0

Requires OpenCode 2.0.28. It fails to load on OpenCode 2.0.26 and earlier, which ship an older Effect runtime; use 0.2.8 there.

- Update OpenCode dependencies to `2.0.28` and Effect to `4.0.1` so Threads loads with the host's stable Effect runtime. Heartbeat accepts `2.0.28` as well as `2.0.26`, with matching registered and live versions required.
- Fresh workflow workers wait for their task after a worktree move. An earlier native idle outcome no longer causes a false write interruption.
- Heartbeat requests normalize OpenCode's unbracketed local IPv6 registration URLs in memory, preserve exact version and PID checks, and reject redirects. Native registration files remain unchanged.
- Streamed text, reasoning, tool input, compaction, step content and tool progress no longer trigger worker or workflow snapshots. Lifecycle and attention events still refresh immediately; progressing workflows and open workflow panels retain periodic freshness.
- Add durable workflow heartbeat tools and a packaged, connect-only macOS runner. Optional wake caps and deadlines survive restarts and run replacement without replenishment.
- New workflows have no built-in token, total-step, runtime, retry-attempt, or discovery-round budgets. Budgets are opt-in, and authoring guidance forbids agent-estimated limits. Existing runs retain their original limits and helper behavior.
- Workflows notify their coordinator when a checkpoint needs a response or execution is interrupted. Durable receipts prevent duplicate notices after inspection or restart.
- Worker follow-ups send a separate, message-correlated completion notice while preserving the original report. Rejected sends no longer grant workflow execution.
- Resuming an expired workflow interrupts its retained workers before reporting the timeout.
- Workflow lists refresh after an in-flight request when you switch conversations or another update arrives.
- Worker snapshots and tab restoration no longer resume pending follow-ups. A rejected follow-up wake cannot block these UI reads.
- Background follow-up recovery keeps rejected records pending and continues with healthy records. Recovery failures no longer prevent the coordinator's next model turn.
- Heartbeat policy updates preserve omitted settings, including custom intervals and acknowledgement limits.
- Heartbeat installation preserves existing launchers on collisions and waits for confirmed removal during uninstall. Native wildcard service addresses connect through loopback.
- Global terminal state falls back from a missing Location to another observed Location. Successful worker snapshots remove stale rows for their requested coordinators.
- Managed-worker notices display structured RPC messages and missing-directory paths instead of `[object Object]`.
- Worker permissions preserve ordered caller and role exceptions while retaining explicit denies and external-directory approval requests.
- Engine unloads retain typed interruption details. Heartbeats can request inspection of interrupted coordinator checkpoints with no worker steps, while human gates remain held.
- Blocked worker recovery identifies its workflow and notifies the owner. Restart notices do not authorize worker execution.

## 0.2.8

- Removed the workflow status line above the prompt. Use `/workflows` to open a run's panel.
- Clicking the footer's workflow count opens the running workflow's panel, or the `/workflows` list when several runs are active. The rest of the indicator still opens the Threads list.
- Added a **Workflows** section to the sidebar. It lists unfinished runs of the current conversation, and a click on a row opens that run's panel.
- The `/workflows` list shows step progress as `2 of 3 steps done` instead of `2/3 recorded steps`.

## 0.2.7

- Rewrote the README and split the docs into guides, configuration, reference, and design pages.

## 0.2.6

- The Threads list shows only the current conversation and its workers.
- The footer counts the same workers as the list, including in a worker's tab.
- Removed the Activity sidebar, pins, automatic worker tabs, native tab reordering, and saved-title cleanup. The `activity` and `workerTabs` terminal options are ignored.

## 0.2.5

Release candidate, not published to npm. Its changes shipped in 0.2.6.

- The footer indicator and the Threads list replaced the sidebar as the default view.
- `paths` lets workers and workflow steps use folders outside their directory without asking.
- Idle terminals no longer wake idle OpenCode Locations.

## 0.2.4

- Workflow workers recover from assistant prefill failures.

## 0.2.3

- Workflow worktrees work across nested projects.

## 0.2.2

- The npm package ships a precompiled terminal UI. This fixes the `Cannot find package 'react'` error in 0.2.0 and 0.2.1.

## 0.2.1

- Included the JSX configuration in the package. This did not fix loading from `node_modules`. Use 0.2.2 or later.

## 0.2.0

- Added dynamic workflows: `/workflow-run`, `/workflows`, saved scripts, checkpoints, retained worktrees, and restart recovery.
- Added the `workflowConcurrency` and `workflowMaxAgents` options.

## 0.1.8

- Last release before workflows.

## 0.1.7

- Compatibility with OpenCode 2.0.7.

## 0.1.6

- Added `agent` to start workers with a configured profile.

## 0.1.3

- Workers that pass hide by themselves. Reports reach the coordinator silently.

## 0.1.0

- First release: managed top-level worker sessions with durable reports.
