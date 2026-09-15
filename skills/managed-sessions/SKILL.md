---
name: Managed sessions
description: Spawn and monitor visible top-level OpenCode workers with op-threads. Use when VERA needs independent workstreams, separate conversations, or durable workers alongside native subagents.
---

# Managed sessions

Choose the delegation mode for each task. The parent can mix both modes in the same run.

- Use native `subagent` for a bounded task or review.
- Use `threads_spawn` for an independent workstream with its own visible session and assigned directory.

Both the parent and managed workers may use native `subagent` when useful. Delegation is optional. Managed workers cannot create further managed workers. Count both modes and workers' native subagents against the active protocol's delegation budget. Keep every writer in its own assigned worktree. These tools do not create worktrees.

## Start work

1. Confirm the `threads_spawn` tool is available. If it is unavailable, use native `subagent` or report that the plugin needs activation. Do not substitute a hidden `opencode run` process.
2. Assign an existing absolute directory and a stable task key.
3. Call `threads_spawn` with `key`, `title`, `directory`, and `task`. Include the goal, scope, relevant context, constraints, delegation allowance, acceptance criteria, verification commands, and expected report in `task`.
4. Save the returned worker session ID with the work unit.

An identical spawn key retries the original admission. Different work requires a new key. A worker inherits the coordinator's agent, model, and permission constraints. It has a separate conversation, so include all context it needs in the task brief.

## Write the delegation allowance

The parent writes `task`; the plugin appends worker instructions. Give workers the option to delegate without requiring a sub-coordinator role. Include this allowance and the worker's share of the remaining delegation budget:

> You may work directly or use native `subagent` for bounded tasks and reviews when useful. Pass your scope and constraints to subagents, review their results, and resolve outstanding work before calling `threads_report` yourself.

Use a no-delegation restriction only for a task-specific reason or an explicit user constraint, and state the reason. Being a managed worker or having bounded scope does not by itself make the worker a leaf. To limit managed-thread nesting, say `Do not call threads_spawn` rather than `No children`.

## Coordinate

- Use `threads_list` for a progress snapshot when making a scheduling or delivery decision.
- Use `threads_send` with a stable message key for a correction or follow-up within the worker's assigned task.
- Use `threads_interrupt` to stop that worker's execution.
- Use `threads_hide` with `workerID` when a worker is no longer needed in the sidebar. This preserves its report and conversation. Hiding does not interrupt work or free an admission slot.
- Do not repeatedly query status while waiting. Workers report to the coordinator through OpenCode's durable inbox.
- After a service restart, inspect existing worker IDs before deciding whether to resume them. Do not launch replacement tasks solely because a session is idle.

## Finish

The worker reviews its subagents' results and resolves outstanding work before calling `threads_report` with a combined verdict, concise summary, and concrete evidence, then stops. Native subagents return results to the worker. Valid verdicts are `PASS`, `PASS WITH NOTES`, `FAIL`, and `INCONCLUSIVE`. Report partial work and blockers honestly.

A worker report is a claim to review. Run the protocol's independent verification before marking the work unit complete. An idle session or a stopped loading indicator does not establish task success.

## Visibility

The TUI plugin opens managed workers as ordinary tabs without changing focus. Workers with `PASS` or `PASS WITH NOTES` reports hide automatically once inactive. Failed, inconclusive, and unreported workers stay visible until the coordinator hides them. Running, selected, and attention-needed tabs stay open. Use `/threads` to restore hidden tabs for inspection. Sending a valid follow-up also restores that worker. Reports are delivered silently to the coordinator and remain available through `threads_list`.
