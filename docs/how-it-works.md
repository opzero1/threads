# How Threads works

This page explains the design behind Threads and what it doesn't support. You don't need it to use Threads. The current rules are in [Work with workers](workers.md) for workers, and in the [workflow runtime contract](../skills/workflow-authoring/references/runtime.md) and [Configuration](configuration.md) for workflows. [Verification history](verification-history.md) records what earlier releases measured.

## Workers, workflows, and subagents

OpenCode's built-in subagents suit a quick lookup or a small review whose answer comes straight back to the caller. Threads workers suit work that needs a separate conversation you can open, read, and follow up on. Each worker can use its own folder or worktree, agent profile, and model.

A worker reports a verdict with evidence. Finishing a run is not the same as passing: a worker that stops without a report has no verdict. Reports arrive in the conversation that started the worker, without polling.

Workflows coordinate agents that run in parallel or depend on earlier results. A workflow keeps a journal, so a resumed run can reuse completed steps instead of repeating them.

Workers can use OpenCode's built-in subagents, but they cannot start Threads workers of their own. This keeps ownership one level deep.

## One package, two plugins

OpenCode V2 runs plugins in two places, so Threads ships two entry points from one package.

The server plugin, `index.ts`, owns the tools, the worker index, the workflow runner, and the `threads` RPC. The terminal plugin, published as `tui.js`, draws the footer indicator, the Threads list, the workflow panel, and the sidebar's Workflows section. The terminal plugin only reads state. Everything that changes a worker goes through the server.

## Why requests carry keys

The coordinator's ID and the spawn `key` determine the worker ID, and a `threads_send` key determines the message ID. A retried call finds what the first call created instead of starting a second worker or delivering a message twice. The plugin stores a fingerprint of each spawn request, so a key can't quietly name different work, and a retry doesn't reset the worker's agent or model even if the profile changed since.

A report belongs to the worker's original report message ID, so a worker recreated after deletion can't inherit an old verdict.

## Why a profile is checked twice

The plugin resolves an `agent` profile in the worker's `directory`, after OpenCode loads that folder's configuration. Just before the first prompt, it checks again that the caller may select that profile. If the profile isn't available, the task doesn't start and the worker stays in the index until the identical spawn request is repeated.

OpenCode's plugin API can't ask for approval for an agent ID chosen at runtime. That is why selecting a profile needs an existing `allow` rule for `subagent` on that ID.

## How worker permissions are composed

A worker with `agent` runs under the profile's rules, followed by session rules that Threads derives from the coordinator's session rules. When the plugin has the profile's rules, it pairs every coordinator rule with every profile rule in order and keeps the stricter effect of each overlap. OpenCode's last-match order therefore still holds: a coordinator `allow` exception after a broader `deny` or `ask`, such as `read *.env.example` after `read *.env.*`, survives where the profile also allows it. A coordinator `allow` never grants what the profile doesn't, and an overlap the plugin can't represent exactly becomes a denial.

For a Threads worker, the plugin loads the profile's rules for this only when the worker has `paths` or the coordinator has an `ask` rule that covers `external_directory`. Otherwise it keeps only the coordinator's restrictions, and allow exceptions that follow them are dropped. Workflow steps follow the [runtime contract](../skills/workflow-authoring/references/runtime.md#external-directories).

Each worker also gets one explicit grant for `threads_report`. The tool's handler checks that the caller is the original worker, so even a read-only worker can report.

## Reports and worker slots

Threads treats a missing verdict as unfinished work, not as success. A worker whose run ends normally without a report therefore keeps its `maxWorkers` slot. A workflow step worker is the exception: it also frees its slot when its step fails or its workflow ends. A step whose task finishes without a `workflows_result` report fails instead of being retried.

A workflow step accepts at most 5 rejected `workflows_result` submissions. Threads counts both kinds: arguments that OpenCode rejects against the tool's schema before the handler runs, which it observes through the `execute.after` tool hook, and results its handler rejects for the step's JSON schema or size limits. Each tool call counts once, identified by its session, message, and call IDs, and the record survives restarts. Unrelated failures, such as storage errors or a run that no longer accepts results, don't count. At the limit, the step fails with the last validation error and can't be retried, and Threads interrupts the worker whether or not the workflow is waiting on it. The worker can't generate again, even after an owner follow-up, and a valid result it submits later is refused. A result accepted before the limit stays accepted. This is a fixed liveness guard, not a budget, so it has no option.

`threads_report` delivers the report to the coordinator as a silent synthetic message, so the agent sees it without a notification row in your conversation.

## Why Threads doesn't open tabs

Each open tab makes OpenCode load that session's Location, including its MCP servers, every time a terminal starts. A worker tab that opened by itself would keep a finished worker's Location awake long after the work ended. So Threads opens a worker's tab only when you choose the worker in the Threads list.

The terminal plugin doesn't request snapshots for streamed text, reasoning, tool input, compaction deltas, step content, or tool progress. These events change conversation content, not worker reports or workflow journals. Session lifecycle and metadata events, permission requests, and forms still trigger refreshes.

Worker state polls every 3 seconds only while a tab is busy or needs input, or a known worker is running. Workflow state polls on the same interval while a run can progress or the workflow panel is open, because journal updates emit no session event.

OpenCode itself still refreshes catalogs for any Location that starts while a terminal is connected, including a worker's. Threads can't prevent that. See the [Loaded Locations measurements](verification-history.md#version-025-loaded-locations).

## Crashes and restarts

Creating a session and indexing it are two separate writes, and so are admitting a report and saving its view. A crash between them leaves the first write in place, so repeating the identical request finishes the second without duplicating the first.

Each `threads_send` key has a durable record and a pending record until its completion notice is delivered. A follow-up moves from `prepared` to `accepted` when admitted, then to `woken` when its wake is delivered. An interrupt marks follow-ups that have not started as `held`. Recovery does not wake `woken` or `held` messages; an explicit send can resume them. Completed messages move through `completed` and `notified`. See [interrupting and held follow-ups](reference.md#interrupting-and-held-follow-ups) for the native-queue limitation.

Recovery reuses the recorded message IDs, so a retried delivery can't duplicate the message or its completion notice. Startup itself replays nothing: it never sends a first prompt or a report again. See [after a crash or restart](workers.md#after-a-crash-or-restart) for what to do.

Workflows have their own journal and recovery rules. See [Start and control](../skills/workflow-authoring/references/runtime.md#start-and-control).

## Unsupported

- More than one OpenCode server process, or duplicate loaded copies of the plugin that share storage. The per-coordinator worker limit and the workflow scheduler aren't shared across processes.
- Deleting individual workflow journal records, or deleting a run record while keeping its legacy completion journal.
