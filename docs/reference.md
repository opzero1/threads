# Reference

This page lists the Threads worker tools, their fields, and the data they return, plus [`workflows_prune`](#workflows_prune). For the other workflow tools and script syntax, see the [workflow runtime contract](../skills/workflow-authoring/references/runtime.md).

## Tools

The tools use the namespace `threads`. Each tool returns JSON in the native `content` and the same value in `output`.

| Tool | Input | Result | Who can call it |
| --- | --- | --- | --- |
| `threads_spawn` | `{ key, title, directory, task, agent?, paths? }` | `WorkerView` | A conversation that is not a worker or a subagent |
| `threads_list` | `{}` | `{ workers: WorkerView[] }` | The coordinator |
| `threads_send` | `{ workerID, key, text }` | `{ workerID, messageID }` | The worker's coordinator |
| `threads_interrupt` | `{ workerID }` | `WorkerView` | The worker's coordinator |
| `threads_hide` | `{ workerID }` | `WorkerView` | The worker's coordinator |
| `threads_report` | `{ verdict, summary, evidence }` | `{ workerID, report }` | The worker itself, once |

## Native and Code Mode tools

Five tools are native tools that the model calls directly: `threads_spawn`, `threads_send`, `threads_report`, `workflows_start`, and `workflows_result`. Every other Threads tool is a [Code Mode](https://opencode.ai/v2/docs/build/plugins) tool, so its schema stays out of each request until an agent needs it. An agent calls these tools inside OpenCode's `execute` tool:

| Tool ID | Code Mode path |
| --- | --- |
| `threads_list`, `threads_interrupt`, `threads_hide` | `tools.threads.list`, `tools.threads.interrupt`, `tools.threads.hide` |
| `workflows_list`, `workflows_inspect`, `workflows_control` | `tools.workflows.list`, `tools.workflows.inspect`, `tools.workflows.control` |
| `workflows_save`, `workflows_saved`, `workflows_prune` | `tools.workflows.save`, `tools.workflows.saved`, `tools.workflows.prune` |
| `workflows_heartbeat_enroll`, `_update`, `_rebind`, `_stop`, `_inspect` | `tools.workflows.heartbeat_enroll`, and so on |

For example, `execute` with `return await tools.threads.list({});` lists your workers. Inside `execute`, `search({ namespace: "threads" })` or `search({ namespace: "workflows" })` finds the tools that are not in the initial catalog.

Inputs, results, and ownership checks are the same either way. Permission rules still match the tool IDs, such as `threads_list`, and `workflows_prune` and `workflows_save` still need the `edit` permission. An agent whose permissions deny `execute` can't reach the Code Mode tools. The report tools stay native because read-only workers can't use `execute`.

All fields are strings except `evidence` and `paths`, which are arrays of strings.

The plugin identifies the caller from the calling session. The conversation that starts a worker is its **coordinator**.

## `threads_spawn` fields

| Field | Required | Meaning |
| --- | --- | --- |
| `key` | Yes | Stable task name. The same coordinator and key always name the same worker. |
| `title` | Yes | Conversation title. |
| `directory` | Yes | Existing absolute folder where the worker runs. |
| `task` | Yes | The brief. The plugin appends worker instructions to it. |
| `agent` | No | Configured agent ID to use as the worker's profile. Without it, the worker inherits the coordinator's agent and model. |
| `paths` | No | Existing absolute folders outside `directory` that the worker may use without asking. |

`paths` rejects relative, missing, and non-directory paths, the filesystem root, and paths that contain `*`, `?`, or a backslash. The plugin resolves symlinks and stores the sorted list.

Changing `title`, `directory`, `task`, `agent`, or the resolved `paths` under an existing key is an error. Use a new key for different work.

## `threads_send` fields

`key` is scoped to the worker and determines the message ID. Sending the same key again with the same text is a safe retry. Sending it with different text is an error.

The result confirms admission, not completion. A separate durable notice identifies the follow-up message and its native outcome: `succeeded`, `failed`, or `interrupted`. The notice does not replace the original report or establish a task verdict.

Pending deliveries reconcile when the coordinator lists workers or enters a model turn. Retries reuse the recorded message IDs. If compaction removes the worker's follow-up message before completion is recorded, that completion remains unresolved because the SDK exposes only compacted context.

Background recovery isolates rejected records and continues through the current page. Failed records remain pending for a later pass. The coordinator's context includes bounded diagnostics with the worker and message IDs. Explicit `threads_send` calls still return their own admission or wake errors.

## `threads_report` fields

| Field | Meaning |
| --- | --- |
| `verdict` | `PASS`, `PASS WITH NOTES`, `FAIL`, or `INCONCLUSIVE` |
| `summary` | Non-empty text |
| `evidence` | List of strings, such as commands run and their results |

A worker reports once. Repeating the identical report returns the original. A different second report is rejected.

## `WorkerView`

| Field | Type | Meaning |
| --- | --- | --- |
| `workerID` | string | The worker's session ID. |
| `coordinatorID` | string | The coordinator's session ID. |
| `key` | string | The spawn key. |
| `title` | string | The conversation title. |
| `directory` | string | The worker's folder. |
| `agent` | string or `null` | The agent saved on the session. |
| `model` | `{ providerID, id, variant? }` or `null` | The model saved on the session. |
| `outcome` | `succeeded`, `failed`, `interrupted`, or `null` | How the last run ended. `null` before the first run ends. |
| `report` | `{ verdict, summary, evidence }` or `null` | The worker's report. |
| `hidden` | boolean | Whether the worker is hidden from the list. |

`outcome` describes the agent loop, not the task. `succeeded` means the loop ended normally. Only `report` says whether the task passed.

## Worker states in the list

The Threads list shows one status for each worker:

| Status | Meaning |
| --- | --- |
| `needs input` | Waiting for a permission or a form answer. |
| `running` | Working now. |
| `PASS`, `PASS WITH NOTES`, `FAIL`, `INCONCLUSIVE` | The worker's report. |
| `starting` | Created, and its first run hasn't ended yet. |
| `no report` | The run ended normally without a report. |
| `failed`, `interrupted` | The run ended that way without a report. |

## Session metadata

Each worker session carries an `opThreads` metadata object with exactly `workerID`, `coordinatorID`, `key`, `fingerprint`, `initialMessageID`, and `reportMessageID`.

- Workers started with `agent` also carry `opThreadsRole: true`.
- Workers started with `paths` also carry `opThreadsPaths`, the resolved list.

Workers have no native `parentID`. They are top-level sessions.

## `workflows_prune`

Lists, and with `apply: true` removes, the step worktrees that finished workflow runs left behind. Agents call it through Code Mode as `tools.workflows.prune`. See [clean up worktrees](workflows.md#clean-up-worktrees) for the rules.

| Field | Required | Meaning |
| --- | --- | --- |
| `apply` | No | `true` removes the checkouts listed as `would-remove`. The default, `false`, changes nothing. |
| `olderThanDays` | No | Only runs that ended at least this many days ago, from 0 to 3,650. A run without a recorded end time, such as one that ended before this release, uses its last update time. |

Who can call it: a top-level conversation whose agent can edit files. It covers every run in that conversation's project.

The result is `{ applied, worktrees, counts }`. `counts` has `removed`, `wouldRemove`, and `kept`. Each entry in `worktrees` has these fields:

| Field | Meaning |
| --- | --- |
| `runID`, `runStatus` | The run and its status. |
| `key` | The step key. |
| `directory` | The step's checkout. |
| `outcome` | `removed`, `would-remove` (dry run), or `kept`. |
| `reason` | Why it was kept: `changes`, `commits`, `nested`, `in-use`, `unregistered`, `error`, or `unfinished` (the run can still resume). |
| `message` | Details for `reason`. |

Checkouts that no longer exist are left out. With `apply: true`, the outcomes of finished runs are also recorded in the run's `worktreeCleanup`, which `workflows_inspect` returns.

## RPC

The terminal plugin reads worker state through the `threads` RPC, defined as `ThreadsRpc` in [`src/rpc.ts`](../src/rpc.ts).

| Method | Effect |
| --- | --- |
| `snapshot` | Returns the workers of the given coordinators without delivering pending follow-ups. Removes stale index entries for deleted workers. |
| `restore` | Clears the hidden state of the given coordinators' workers, then returns them. |

Both methods take `{ coordinatorIDs: string[] }`, with at most 100 IDs, and return `{ workers: WorkerView[] }`. Raw HTTP requests wrap the input: `{ "input": { "coordinatorIDs": ["ses_..."] } }`.
