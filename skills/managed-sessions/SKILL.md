---
name: Managed sessions
description: Spawn and monitor visible top-level OpenCode workers with op-threads. Use when VERA needs independent workstreams, separate conversations, or durable workers alongside native subagents.
---

# Managed sessions

Choose the delegation mode before launching work.

- Use native `subagent` for a bounded task or review.
- Use `threads_spawn` for an independent workstream with its own visible session and assigned directory.

Count both modes against the active protocol's delegation budget. Managed workers can use native subagents, but cannot create further managed workers. Keep every writer in its own assigned worktree. These tools do not create worktrees.

## Start work

1. Confirm the `threads_spawn` tool is available. If it is unavailable, use native `subagent` or report that the plugin needs activation. Do not substitute a hidden `opencode run` process.
2. Assign an existing absolute directory and a stable task key.
3. Call `threads_spawn` with `key`, `title`, `directory`, and `task`. Include the goal, scope, relevant context, constraints, acceptance criteria, verification commands, and expected report in `task`.
4. Save the returned worker session ID with the work unit.

An identical spawn key retries the original admission. Different work requires a new key. A worker inherits the coordinator's agent, model, and permission constraints. It has a separate conversation, so include all context it needs in the task brief.

## Coordinate

- Use `threads_list` for a progress snapshot when making a scheduling or delivery decision.
- Use `threads_send` with a stable message key for a correction or follow-up within the worker's assigned task.
- Use `threads_interrupt` to stop that worker's execution.
- Do not repeatedly query status while waiting. Workers report to the coordinator through OpenCode's durable inbox.
- After a service restart, inspect existing worker IDs before deciding whether to resume them. Do not launch replacement tasks solely because a session is idle.

## Finish

The worker calls `threads_report` with a verdict, concise summary, and concrete evidence, then stops. Valid verdicts are `PASS`, `PASS WITH NOTES`, `FAIL`, and `INCONCLUSIVE`. Report partial work and blockers honestly.

A worker report is a claim to review. Run the protocol's independent verification before marking the work unit complete. An idle session or a stopped loading indicator does not establish task success.

## Visibility

The TUI plugin opens managed workers as ordinary tabs without changing focus. Each tab uses OpenCode's native activity indicators. Use `/threads` to reopen managed worker tabs you closed.
