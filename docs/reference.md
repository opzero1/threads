# Reference

This page lists the Threads worker tools, their fields, and the data they return. For workflow tools and script syntax, see the [workflow runtime contract](../skills/workflow-authoring/references/runtime.md).

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

## RPC

The terminal plugin reads worker state through the `threads` RPC, defined as `ThreadsRpc` in [`src/rpc.ts`](../src/rpc.ts).

| Method | Effect |
| --- | --- |
| `snapshot` | Returns the workers of the given coordinators. Read-only. |
| `restore` | Clears the hidden state of the given coordinators' workers, then returns them. |

Both methods take `{ coordinatorIDs: string[] }`, with at most 100 IDs, and return `{ workers: WorkerView[] }`. Raw HTTP requests wrap the input: `{ "input": { "coordinatorIDs": ["ses_..."] } }`.
