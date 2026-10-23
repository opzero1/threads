# Work with workers

A worker is a separate OpenCode conversation that your conversation starts and owns. This guide covers the everyday tasks: starting a worker, watching it, following up, and cleaning up.

You rarely call the tools yourself. You ask your agent, and it calls them. The examples show the tool calls so you know what to ask for. For every field and limit, see the [reference](reference.md).

## Start a worker

Give the worker a folder, a short title, and a complete brief:

```text
threads_spawn({
  key: "review-auth",
  title: "Review authentication",
  directory: "/absolute/path/to/worktree",
  task: "Review the authentication changes on this branch. Report findings with file paths and the commands you ran."
})
```

- `key` names the task. If the agent retries with the same key and the same request, it gets the same worker back instead of a second one.
- `directory` must be an existing absolute path. Threads doesn't create worktrees. Give each worker that edits files its own worktree.
- `task` is the brief. The worker starts with an empty conversation, so the brief must hold everything it needs: the goal, the scope, the constraints, how to verify, and what to report.

The worker starts without opening a tab. Your conversation stays free.

Each conversation can have 4 unfinished workers at a time. To change that limit, set [`maxWorkers`](configuration.md#server-options).

## Pick an agent and model

Without `agent`, the worker uses the same agent and model as your conversation.

To use a different configured profile, set `agent`:

```text
threads_spawn({ ..., agent: "vera-auditor-readonly" })
```

The worker then gets that profile's system prompt, model, and permissions. A profile without a model uses your conversation's model. Naming a role in the brief doesn't select it. Only `agent` does.

To select a profile, your own permissions must allow `subagent` for that agent ID. If a rule denies or asks, Threads rejects the request before it creates the worker.

A selected worker never gets more access than your conversation has. Your conversation's session rules can only narrow the profile's permissions:

- Their `deny` and `ask` rules become denials on the worker.
- An `ask` for `external_directory` stays an approval request in the worker's tab, unless the profile denies that folder.
- Your `allow` rules never grant the worker what its profile doesn't. See [how worker permissions are composed](how-it-works.md#how-worker-permissions-are-composed) for when your allow exceptions are kept.

If the profile isn't available when the worker starts, the task doesn't start. Fix the profile configuration, then repeat the identical spawn request. Until then, the worker rejects follow-ups.

## Give access to another folder

A worker asks before it uses a folder outside its `directory`. To let it use a reference repository without asking, list the folder in `paths`:

```text
threads_spawn({ ..., paths: ["/absolute/path/to/reference-repo"] })
```

The worker can then use that folder and everything inside it without an approval prompt. Its own permissions still decide what it can do there, so a read-only worker still can't edit. Explicit `external_directory` denies in your configuration or the profile still apply, and a grant that such a deny blocks fails before the worker is created.

Without `paths`, the worker asks for approval in its own conversation, and the footer shows it as needing input.

## Watch workers

While workers run, the prompt footer shows a spinner and counts:

```text
⠋ 2 workers · 1 workflow ? 1 needs input ctrl+x j
```

- `2 workers` counts this conversation's running workers.
- `1 workflow` counts this conversation's running workflows.
- `? 1 needs input` counts workers that wait for a permission or a form answer.

The footer shows nothing when nothing is running. On the home screen, it counts all known workers.

Click `1 workflow` to open that workflow's panel. When several workflows run, the click opens the workflow list instead. See [Run a dynamic workflow](workflows.md#inspect-progress).

Click anywhere else on the indicator, or press `ctrl+x j`, to open the Threads list. It shows your conversation and its workers in this order, with the group and status beside each title:

- **Needs attention**: workers that wait for a permission or a form answer.
- **Running**: workers, and your conversation, while they run.
- **Main**: your conversation, when it's idle.
- **Finished**: idle workers with their verdict or status, such as `FAIL` or `no report`.
- **Closed**: rows you dismissed.

In the list:

- Type to search.
- Press **Enter** on a row to show its menu. Choose **Open** to open the conversation in a tab, or **Dismiss** to close the row. A closed row offers **Restore** instead.
- Press **Esc** to close the list.

If you open a worker that hasn't reported yet, its tab closes by itself after the worker reports, once you leave the tab.

In a worker's tab, the list shows that worker's main conversation and its other workers.

## Follow up with a worker

To correct or add to the task, ask the agent to send a message:

```text
threads_send({ workerID: "ses_...", key: "use-staging", text: "Test against staging, not local." })
```

Use a new `key` for each message. Keep follow-ups within the original task. For new work, start a new worker.

When the follow-up finishes, inspect its completion notice and the worker's evidence. The notice identifies your message and its native execution outcome. The original report stays unchanged.

## Stop or hide a worker

Agents call these tools, and `threads_list`, through [Code Mode](reference.md#native-and-code-mode-tools).

- `threads_interrupt` stops the worker's current run. The conversation stays. Follow-ups that haven't started yet are held instead of run, and the result lists them in `heldFollowups`. No later list or turn starts them. Your next `threads_send` to that worker resumes them first, in their original order, and lists them in `resumedFollowups`. Any it couldn't redeliver are listed in `failedFollowups` with their errors and retried later.
- `threads_hide` removes the worker from the list and closes its tab. It keeps the conversation and the report. Hiding doesn't stop the worker and doesn't free its slot.

Workers that report `PASS` or `PASS WITH NOTES` hide by themselves once they are idle. Workers that report `FAIL` or `INCONCLUSIVE`, or that stop without a report, stay under **Finished** so you notice them.

To bring back hidden and dismissed workers, run `/threads`.

## Read reports

A worker ends its task by calling `threads_report` with a verdict, a summary, and evidence. The verdict is `PASS`, `PASS WITH NOTES`, `FAIL`, or `INCONCLUSIVE`.

The report goes to your conversation's agent. To see every worker's report at once, ask the agent to run `threads_list`.

A report is the worker's claim. Check its evidence before you accept the work. A worker that goes idle without a report has no verdict at all.

## After a crash or restart

Threads doesn't start or resume work at startup. Ask the agent to check existing workers with `threads_list` before it starts new ones. An idle worker isn't a reason to start its task again.

If a crash interrupted `threads_spawn`, `threads_send`, or `threads_report`, repeat the identical call. Threads finds the worker, message, or report that the first call recorded instead of creating another. Follow-ups that never reached the worker are sent again when the agent lists workers or starts its next turn. Threads doesn't wake a worker again for a follow-up it already delivered or held, so a stopped worker stays stopped.

## Let workers use subagents

Your conversation and its workers can both use OpenCode's built-in subagents for small side tasks. Workers can't start workers of their own.

Threads adds a note to every brief that says subagents are optional. If a worker must not use subagents, say so in the brief and give the reason.
