# Changelog

## Unreleased

- Administrative tools are now Code Mode tools, so their schemas leave every request's native tool list. Agents call them inside OpenCode's `execute` tool: `tools.threads.list`, `interrupt`, and `hide`, and `tools.workflows.list`, `inspect`, `control`, `save`, `saved`, `prune`, and the five `heartbeat_*` tools. `threads_spawn`, `threads_send`, `threads_report`, `workflows_start`, and `workflows_result` stay native, so read-only workers, which can't use `execute`, can still report. Tool IDs, inputs, results, and permission rules are unchanged. An agent whose permissions deny `execute` loses the administrative tools.
- Workflow notices and the bundled skills point agents to the Code Mode paths.

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
