# How Threads works

This page explains the design behind workers: how retries stay safe, where permissions come from, and what happens after a crash. You don't need it to use Threads. For everyday use, see [Work with workers](workers.md).

## One package, two plugins

OpenCode V2 runs plugins in two places, so Threads ships two entry points from one package.

The server plugin, `index.ts`, owns the tools, the worker index, the workflow runner, and the `threads` RPC. The terminal plugin, published as `tui.js`, draws the footer indicator, the Threads list, and the workflow panel. The terminal plugin only reads state. Everything that changes a worker goes through the server.

## Worker identity and retries

The coordinator's ID and the spawn `key` together determine the worker ID. The plugin also stores a fingerprint of the request. That makes `threads_spawn` safe to retry:

- The same key with the same request returns the original worker and its original first message. The plugin doesn't reset its agent or model, even if the profile changed since.
- The same key with a different title, directory, task, agent, or resolved `paths` is an error.

Messages work the same way. A `threads_send` key determines the message ID, so a retry can't deliver a message twice. Reports are one per worker. The saved report belongs to the original report message ID, so a worker recreated after deletion can't inherit an old verdict.

Startup never replays a first prompt. If creation was interrupted, the agent repeats the identical spawn request to finish it.

## Starting a worker with a profile

When `agent` is set, the plugin resolves the profile in the worker's `directory`, after OpenCode loads that folder's configuration. Just before the first prompt, it checks again that the caller may select that profile, and it selects the profile's model.

If the profile isn't available, the task doesn't start. The worker stays in the index. Fix the profile configuration, then repeat the identical spawn request. Until the first prompt is admitted, the plugin rejects follow-ups and direct prompts to that worker.

## Worker permissions

Without `agent`, a worker inherits the coordinator's agent permissions, followed by its session permissions.

With `agent`, the worker uses the selected profile's permissions. The coordinator's session rules can only narrow them:

- Every `deny` and `ask` rule of the coordinator becomes a hard denial on the worker.
- The coordinator's `allow` rules are not copied, including allow exceptions after a denial. A read-only profile can't gain access through its parent.
- One exception keeps approvals working. A coordinator `ask` for `external_directory` stays an approval request in the worker's tab, unless the profile denies that folder.

`paths` grants `external_directory` for the listed folders only. It doesn't add tools. Explicit `external_directory` denies from the coordinator or the profile still win, and a grant that such a deny blocks fails before the worker is created.

Each worker gets one explicit grant for `threads_report`. The tool's handler checks that the caller is the original worker, so even a read-only worker can report.

OpenCode's plugin API can't ask for approval for an agent ID chosen at runtime. That is why selecting a profile needs an existing `allow` rule for `subagent` on that ID.

## Worker slots

`maxWorkers` counts unfinished workers per coordinator. A worker holds its slot until it reports, or until its run fails or is interrupted.

A worker whose run ends normally without a report keeps its slot. Threads treats a missing verdict as unfinished work, not as success. Hiding a worker doesn't free its slot either.

Workflow steps owned by the same coordinator count against the same limit. The plugin checks the limit one request at a time for each coordinator.

## How reports travel

`threads_report` stores the report and delivers it to the coordinator as a silent synthetic message. The agent sees it, but no notification row appears in your conversation. The report also stays available through `threads_list`.

Workers that report `PASS` or `PASS WITH NOTES` hide once they are idle. Other outcomes stay visible, because they need a person or an agent to look at them.

## Why Threads doesn't open tabs

Each open tab makes OpenCode load that session's Location, including its MCP servers, every time a terminal starts. A worker tab that opened by itself would keep a finished worker's Location awake long after the work ended.

So Threads opens a worker's tab only when you choose the worker in the Threads list. A tab you open for an unreported worker closes after it reports, once you leave it.

The terminal plugin also stays quiet while idle. It refreshes worker state after session events, and it polls every 3 seconds only while a tab is busy or needs input, or a known worker is running. Workflow state polls on the same interval only while a run can progress or the workflow panel is open. An idle terminal sends no Threads requests.

OpenCode itself still refreshes catalogs for any Location that starts while a terminal is connected, including a worker's. Threads can't prevent that. The [verification record](workflows-verification.md#loaded-locations) has the measurements.

## Crashes and restarts

Creating a session and indexing it are two separate writes. If the server crashes between them, the worker isn't indexed. Repeat the identical spawn request to finish it.

Admitting a report and saving its view are also separate. If the server crashes between them, repeat the identical report. The coordinator's message is the source of truth and isn't duplicated.

There is no custom outbox and no replay at startup. After a restart, check existing workers with `threads_list` before starting new ones. An idle session isn't a reason to start the work again.

Workflows have their own journal and recovery rules. See [Start and control](../skills/workflow-authoring/references/runtime.md#start-and-control).

## Limits

- Threads assumes one OpenCode server process. The per-coordinator limit check isn't shared across processes.
- Snapshots remove index entries for deleted sessions.
- A worker that never calls `threads_report` has no verdict. Its native outcome stays visible separately.
