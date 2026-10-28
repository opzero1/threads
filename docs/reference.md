# Reference

This page lists the Threads worker tools, their fields, and the data they return, plus [`workflows_prune`](#workflows_prune). For the other workflow tools and script syntax, see the [workflow runtime contract](../skills/workflow-authoring/references/runtime.md).

## Tools

The tools use the namespace `threads`. Each tool returns JSON in the native `content` and the same value in `output`.

| Tool | Input | Result | Who can call it |
| --- | --- | --- | --- |
| `threads_spawn` | `{ key, title, directory, task, agent?, paths? }` | `WorkerView` | A conversation that is not a worker or a subagent |
| `threads_list` | `{}` | `{ workers: WorkerView[] }` | The coordinator |
| `threads_send` | `{ workerID, key, text, delivery? }` | `{ workerID, messageID, steerError?, resumedFollowups?, failedFollowups? }` | The worker's coordinator |
| `threads_interrupt` | `{ workerID, dropHeld? }` | `WorkerView`, `heldFollowups`, `failedRequeues?`, and with `dropHeld`, `droppedFollowups` and `failedDrops?` | The worker's coordinator |
| `threads_hide` | `{ workerID }` | `WorkerView` | The worker's coordinator |
| `threads_set_rule` | `{ workerID, key, text }` | `{ workerID, rules }` | The worker's coordinator |
| `threads_remove_rule` | `{ workerID, key }` | `{ workerID, rules }` | The worker's coordinator |
| `threads_rules` | `{ workerID }` | `{ workerID, rules }` | The worker's coordinator |
| `threads_report` | `{ verdict, summary, evidence }` | `{ workerID, report }` | The worker itself, once |

## Native and Code Mode tools

Five tools are native tools that the model calls directly: `threads_spawn`, `threads_send`, `threads_report`, `workflows_start`, and `workflows_result`. Every other Threads tool is a [Code Mode](https://opencode.ai/v2/docs/build/plugins) tool, so its schema stays out of each request until an agent needs it. An agent calls these tools inside OpenCode's `execute` tool:

| Tool ID | Code Mode path |
| --- | --- |
| `threads_list`, `threads_interrupt`, `threads_hide` | `tools.threads.list`, `tools.threads.interrupt`, `tools.threads.hide` |
| `threads_set_rule`, `threads_remove_rule`, `threads_rules` | `tools.threads.set_rule`, `tools.threads.remove_rule`, `tools.threads.rules` |
| `workflows_list`, `workflows_inspect`, `workflows_control` | `tools.workflows.list`, `tools.workflows.inspect`, `tools.workflows.control` |
| `workflows_save`, `workflows_saved`, `workflows_prune` | `tools.workflows.save`, `tools.workflows.saved`, `tools.workflows.prune` |
| `workflows_heartbeat_enroll`, `_update`, `_rebind`, `_stop`, `_inspect` | `tools.workflows.heartbeat_enroll`, and so on |

For example, `execute` with `return await tools.threads.list({});` lists your workers. Inside `execute`, `search({ namespace: "threads" })` or `search({ namespace: "workflows" })` finds the tools that are not in the initial catalog.

Inputs, results, and ownership checks are the same either way. Permission rules still match the tool IDs, such as `threads_list`, and `workflows_prune` and `workflows_save` still need the `edit` permission. An agent whose permissions deny `execute` can't reach the Code Mode tools. The report tools stay native because read-only workers can't use `execute`.

All fields are strings except `evidence` and `paths`, which are arrays of strings, and `dropHeld`, which is a boolean.

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

`delivery` is `queue` (the default) or `steer`. A queued message runs after the worker's current run ends. A steered message reaches a busy worker at its next step, without waiting for the run to end. Threads admits the message queued, then asks OpenCode's session inbox to steer it. If that fails, the message stays queued, the worker is woken as usual, and `steerError` says why. Steering needs OpenCode 2.2 running as the local service (`opencode serve --service`), because OpenCode serves the inbox over HTTP only; see [inbox access](#inbox-access).

The result confirms admission, not completion. A separate durable notice identifies the follow-up message and its native outcome: `succeeded`, `failed`, or `interrupted`. The notice does not replace the original report or establish a task verdict.

Pending deliveries reconcile when the coordinator lists workers or enters a model turn. Reconciliation wakes the worker only for a follow-up whose wake was never confirmed. Once the wake is delivered, only an explicit `threads_send` wakes the worker again, so reconciliation can't undo an interrupt. Retries reuse the recorded message IDs. If compaction removes the worker's follow-up message before completion is recorded, that completion remains unresolved because the SDK exposes only compacted context.

## Interrupting and held follow-ups

`threads_interrupt` returns the worker's `WorkerView` plus `heldFollowups`: the sorted message IDs of follow-ups that hadn't started when it stopped the run. A follow-up that was already running is interrupted, and its completion notice reports `interrupted`. Held follow-ups get no notice until they run.

By default a held follow-up stays queued in the worker's inbox, and Threads only stops waking the worker for it. A held follow-up that was steered is moved back to the queue before the interrupt, so it can't start at the next step. If that move fails, the result lists it in `failedRequeues` as `{ messageID, error }`, and the follow-up stays held and marked as steered. The next interrupt or send retries the move. A send moves every held steered follow-up back before it wakes the worker. If a move still fails, the send lists that follow-up in `failedFollowups` and keeps it held, but OpenCode may still run it, ahead of queued messages, when the send wakes the worker. It then gets its completion notice as usual. Any later wake runs it: your next `threads_send` to that worker, an identical retry of its key, or a message typed in the worker's tab. `threads_send` redelivers held follow-ups before its own message, and the native queue keeps its original order. `resumedFollowups` lists the message IDs it redelivered. `failedFollowups` lists each one whose admission or wake failed, as `{ messageID, error }` with the error cut to 240 characters. A failed one stays pending, and the next recovery pass or send retries it. Both fields are omitted when empty. A held follow-up that runs still gets its completion notice.

With `dropHeld: true`, Threads removes each held follow-up from the worker's inbox before it interrupts. `droppedFollowups` lists the removed message IDs; they never run and get no completion notice. A follow-up that started before it could be removed is not dropped: it is interrupted and gets its notice. `failedDrops` lists each removal that failed, as `{ messageID, error }`; those stay held. Interrupting an idle worker with `dropHeld` drops follow-ups an earlier interrupt held. Sending a dropped key again is an error; use a new key. Dropping needs the same [inbox access](#inbox-access) as steering.

Redelivery reads the worker's context, which can be compacted. A follow-up that already ran and was compacted away looks unstarted, so an interrupt can hold it and a send can list it as redelivered. It doesn't run twice: Threads doesn't wake a worker when a completed compaction follows the message's admission. Its completion notice stays unresolved, as described above.

Background recovery isolates rejected records and continues through the current page. Failed records remain pending for a later pass. The coordinator's context includes bounded diagnostics with the worker and message IDs. Explicit `threads_send` calls still return their own admission or wake errors.

### Inbox access

OpenCode 2.2 lets clients steer and cancel inbox messages over its HTTP API, but not through the plugin API. Threads calls the API of the OpenCode server it runs in. It finds that server's address and password in the service registration file, `$XDG_STATE_HOME/opencode/service.json` or `~/.local/state/opencode/service.json`, and uses it only when the file names the current process. A server started any other way has no registration. There, `delivery: "steer"` fails before anything is stored, and `dropHeld` lists every held follow-up in `failedDrops`, each with an error that names the requirement. Queued sends and plain interrupts don't need the inbox.

## Worker rules

`threads_set_rule` gives a worker a standing rule, such as "Don't edit `src/config.ts`." `key` names the rule: 1 to 64 lowercase letters, digits, `_`, or `-`. `text` is up to 8,000 characters. Setting an existing key replaces its text. `threads_remove_rule` removes one, and `threads_rules` lists the rules you set, sorted by key. Each returns the worker's current `rules` as `{ key, text }` objects.

Rules use OpenCode 2.2's experimental session instruction entries. The worker sees a new, changed, or removed rule at its next step, including in the middle of a run. Rules are stored with the session, so they stay in the worker's context after compaction and restarts. OpenCode 2.1 has no instruction entries, and the rule tools fail there with an error that names the version.

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
