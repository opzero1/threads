# @op1/threads

Managed top-level worker sessions and dynamic workflows for OpenCode V2. Dynamic workflows target OpenCode 2.0.12. The server entrypoint is `index.ts`; the terminal source is `tui.ts`, compiled to `tui.js` for npm publication.

## Dynamic workflows

Use `/workflow-run <task>` to have OpenCode author a JavaScript workflow with parallel agents, structured handoffs, and a durable run journal. `/workflows` opens the run navigator. Workers use native OpenCode conversations and configured agent profiles, including VERA roles.

Dynamic workflows are included in `@op1/threads` 0.2.0. The `v0.1.8` tag preserves the pre-workflow release.

Read [Run a dynamic workflow](docs/workflows.md) for progress, pause, stop, resume, worktree, and saved-script usage. The [runtime contract](skills/workflow-authoring/references/runtime.md) documents the authoring API, execution limits, and [external directory access](skills/workflow-authoring/references/runtime.md#external-directories): an agent step's `paths` grants directories outside its location.

See [verification evidence](docs/workflows-verification.md) for the native checks and recovery guarantees.

See [capacity and limits](docs/workflow-capacity-findings.md) for total agent steps, concurrent workers, and measured load.

## Install dynamic workflows

Install the versioned plugin globally:

```sh
opencode plugin add @op1/threads@0.2.2
```

Or add it to `plugins` in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["@op1/threads@0.2.2"]
}
```

Keep the other entries in your plugin list. Open a fresh TUI to load the terminal entrypoint. Session tabs must be enabled.

Versions 0.2.0 and 0.2.1 can fail to load the published TUI with a React import error. Version 0.2.1 added the package's JSX configuration, but that alone did not fix loading from `node_modules`.

Version 0.2.2 publishes precompiled Solid UI code. `npm pack` builds `tui.js` automatically; local checkouts keep using `tui.ts`.

The `skills/managed-sessions` directory contains the VERA delegation guide. Copy or link it into `~/.config/opencode/skills/managed-sessions` to make it available to agents.

The internal plugin ID remains `op-threads`, so switching between local and published installs preserves worker records. For local development, clone the `dynamic-workflows` branch, run `bun install`, and use the checkout's absolute path as the plugin entry.

## Delegate work

```text
threads_spawn({
  key: "review-auth",
  title: "Review authentication",
  directory: "/absolute/path/to/assigned-worktree",
  task: "Review the authentication changes. Report findings and verification evidence."
})
```

The worker runs without opening a tab. While it works, the prompt footer shows a spinner and the number of running workers. Press `ctrl+x j`, or run `/activities` or `/threads`, to list the workers and open one in a native tab. Use `threads_list` to inspect reports.

Both the parent and managed workers can use native `subagent` for bounded tasks and role-specific reviews. The parent can mix direct subagent calls with managed threads. Each worker can work directly or delegate within its brief and inherited permissions, then review the results and submit its own combined report.

The parent writes the `task` brief. The plugin appends an explicit reminder that native delegation is optional and that workers cannot call `threads_spawn`. Include the worker's delegation budget in the brief. Use `No children` only when the task requires it, since that also rules out native subagents.

## Tools

The native tool names use namespace `threads` and individual names `spawn`, `list`, `send`, `interrupt`, `hide`, and `report`.

| Tool | Input | Result |
| --- | --- | --- |
| `threads_spawn` | `{ key, title, directory, task, agent?, paths? }` | Worker view |
| `threads_list` | `{}` | `{ workers: WorkerView[] }` |
| `threads_send` | `{ workerID, key, text }` | `{ workerID, messageID }` |
| `threads_interrupt` | `{ workerID }` | Worker view |
| `threads_hide` | `{ workerID }` | Worker view |
| `threads_report` | `{ verdict, summary, evidence }` | `{ workerID, report }` |

All fields are strings except `evidence` and `paths`, which are arrays of strings. Verdicts are `PASS`, `PASS WITH NOTES`, `FAIL`, and `INCONCLUSIVE`. Each tool returns JSON in native `content` and the same value in `output`.

`directory` must exist and be absolute. Without `agent`, the worker inherits the coordinator's active agent and resolved model, with agent permissions followed by session permissions.

Set `agent` to use a configured profile, such as `agent: "vera-core"` for a VERA workstream or `agent: "vera-auditor-readonly"` for an independent review. The plugin resolves the profile in the assigned directory. OpenCode supplies its system prompt and step limit. The profile's model and variant take precedence; a profile without a model inherits the coordinator's resolved model. Explicit selection supports `primary`, `all`, and `subagent` profiles on OpenCode 2.0.7.

Explicit selection requires the caller's ordered agent and session rules to allow `subagent` for that exact agent ID. A matching `deny` or `ask` rejects the request before creation. OpenCode's plugin API cannot request approval for an input-dependent agent ID.

A selected worker uses its profile's permissions. Parent session `deny` and `ask` rules at creation become hard denials on the worker, and parent allows are not copied. This conservative rule also drops parent allow exceptions that follow a denial. It prevents inherited permissions from relaxing a read-only profile. One exception keeps on-demand access: a parent `external_directory` ask stays an approval request in the worker's tab unless the profile denies that directory. Each managed worker receives one explicit grant for `threads_report`, whose handler verifies ownership. Native subagents retain their own profiles and inherit those session restrictions. Omitting `agent` keeps the existing inheritance behavior.

Set `paths` to existing absolute directories outside `directory` that the worker may use without asking, such as a reference repository. Each path and its subdirectories are granted for `external_directory` only, so the worker's own permissions still decide whether it can read, edit, or run commands there. The plugin resolves symlinks and records the sorted list in worker metadata. It rejects relative, missing, and non-directory paths, the filesystem root, and paths containing `*`, `?`, or a POSIX backslash. Explicit `external_directory` denies from the coordinator or the selected profile still apply inside a grant; a grant whose directory they deny fails before the worker is created. Without a grant, other directories follow the worker's permissions.

Tool identity comes from the calling session. Only the owning coordinator can send, interrupt, or hide a worker. Only the exact original top-level worker can report. Native subagents and managed workers cannot spawn managed workers. Native `subagent` remains available.

## Identity and retries

The coordinator ID and spawn key determine the worker ID. Worker metadata contains `opThreads` with exactly `workerID`, `coordinatorID`, `key`, `fingerprint`, `initialMessageID`, and `reportMessageID`. Explicit-role workers also carry `opThreadsRole: true`. Workers with granted paths carry `opThreadsPaths`, the resolved list. There is no native `parentID`.

The first create includes both message IDs. Identical spawn retries reuse the original session and initial message ID, even if the profile configuration has changed. They do not reset its agent or model. Changing the title, directory, task, explicit agent, or resolved `paths` under that key is an error. Requests that omit `agent` retain their pre-role fingerprint, and requests without `paths` keep their earlier fingerprint. Startup never replays initial prompts.

The initial prompt hook resolves a selected profile after OpenCode loads the assigned directory's configuration. It rechecks the caller's role authorization and selects the profile's model before admitting the task. If the profile is unavailable, admission fails without running the task. The indexed worker remains recoverable: fix the profile configuration and retry the identical request. Until initialization completes, managed follow-ups and direct prompts are rejected. Initialization is recorded after native admission; a retry repairs that record if interrupted between the two writes.

Send keys are scoped to the worker and determine a stable message ID. A retry with different text is rejected. Each worker has one task and one terminal report. Identical report retries return the original report; conflicting reports are rejected. Send clarifications within the existing task, and use a new spawn key for new work. The persisted report view is keyed by the original report message ID, so recreating a deleted worker cannot inherit an old verdict.

## Worker views and limits

`WorkerView` contains `workerID`, `coordinatorID`, `key`, `title`, `directory`, `agent`, `model`, `outcome`, `report`, and `hidden`. `agent` and `model` reflect the native session's saved selection, or `null` if unset. A model contains `providerID`, `id`, and an optional `variant`.

`outcome` is the native last execution outcome, or `null` before one exists. It is not current activity. Native tabs display current busy, attention, and unread state.

`report` is the explicit worker claim, or `null`. Native `succeeded` means the agent loop completed, not that the assigned task passed.

`hidden` is the desired idle-tab visibility. Current activity, input requests, or selection can keep that tab open.

Plugin option `maxWorkers` defaults to 4 and accepts integers from 1 through 32. Admission is serialized by coordinator within the loaded server process. A worker without a report continues to occupy a slot unless its native outcome is `failed` or `interrupted`. A successful run without a report does not silently free its slot.

Plugin option `workflowConcurrency` sets the default concurrency for new workflows. It accepts integers from 1 through 8 and defaults to 3. Plugin option `workflowMaxAgents` sets their total agent-step limit, accepts integers from 1 through 1,000, and defaults to 4. Explicit `workflows_start` values override these defaults. Existing runs retain their recorded limits. For eight concurrent agents with eight total steps, configure `"options": { "maxWorkers": 32, "workflowConcurrency": 8, "workflowMaxAgents": 8 }` on the plugin entry.

## Terminal and RPC

The terminal does not open worker tabs by itself. OpenCode loads the Location of every open tab each time a TUI starts, so worker tabs open only when you select a worker in the Threads list. Selecting a row opens its native tab and focuses it. When a worker whose tab the list opened reports and goes idle, the terminal closes that tab unless it is focused, running, or waiting for input. It closes the tab later, once you leave it. Worker tabs opened after a report stay open unless you close them or the worker is hidden. Closing the TUI does not interrupt workers.

Conversations dismissed from the list stay dismissed across restarts. `/threads` restores hidden and dismissed workers of the current coordinator and of open coordinator tabs, then opens the Threads list. It never reopens their tabs.

The Threads list shows titles and compact worker statuses. Main rows have no extra subtitle. Folder and role labels are omitted so titles can use the available width. The list omits a leading `[Main] ` or `[Worker] ` from known managed titles written by older releases, without renaming the saved conversation. Managed identity comes from the worker RPC, including lookups for loaded history conversations whose workers are on older pages. Unrelated prefixed titles remain unchanged.

Workers with `PASS` or `PASS WITH NOTES` reports hide automatically once idle. This also applies to reports saved before upgrading. Hidden workers leave the Threads list and close their tabs. Unreported workers and `FAIL` or `INCONCLUSIVE` reports stay in the list under **Finished**. The selected tab, running workers, and tabs needing input stay open until they are inactive.

The coordinator can call `threads_hide` when a worker is no longer needed. Hiding preserves the conversation and report, survives restarts, and does not free an admission slot. `/threads` restores hidden workers and keeps them visible for inspection. A valid `threads_send` follow-up also restores its worker. Visibility overrides belong to the original report message ID, so recreating a deleted worker cannot inherit its hidden state.

Reports reach the coordinator through silent synthetic messages. They remain available through `threads_list` and the session history without adding a notification row to the conversation. Older report notification rows remain in native history.

The RPC definition is `ThreadsRpc` in `src/rpc.ts`, with ID `threads`. `snapshot` is read-only. The user-invoked `restore` method clears hidden state for the supplied coordinators' workers. Both methods accept and return:

```ts
input: { coordinatorIDs: string[] }
result: { workers: WorkerView[] }
```

The input accepts at most 100 coordinator IDs. Raw HTTP RPC requests wrap the input as `{ "input": { "coordinatorIDs": ["ses_..."] } }`. Each method declares `errors: {}` and the RPC declares `events: {}`. The TUI subscribes to native session events and reconciles at most one snapshot at a time. Events that arrive during a snapshot schedule one more, so the event that finishes a worker is never dropped. The three-second missed-event refresh runs only while a tab is busy or needs input, or a known worker is running. Each RPC is located and loads its OpenCode Location, so an idle TUI sends none.

## Footer indicator and Threads list

Threads adds no sidebar or automatic worker tabs. Like OpenCode's `/btw`, it shows a compact indicator in the prompt footer, and on the home screen footer, only while something needs it:

- A spinner with the number of running workers and of running workflows in the current conversation, for example `⠋ 2 workers · 1 workflow`.
- `? N needs input` in the theme's warning color when workers wait for a permission or form answer. A waiting worker is counted there, not also as running.
- The shortcut that opens the Threads list, in subdued text.

The indicator renders nothing while idle. Click it, press `ctrl+x j`, or run `/activities` to open the Threads list. `/threads` opens the same list after restoring hidden and dismissed workers.

In a conversation, the footer counts only that conversation's managed workers, matching the list. In a worker tab, both use its coordinator's thread. The home-screen footer summarizes all known workers because no conversation is selected.

The list shows the current conversation's thread: its main conversation and that conversation's managed workers. When you are in a worker, it shows the worker's main conversation and siblings. On the home screen it asks you to open a conversation. Other conversations stay in OpenCode's own session list. Rows are grouped in this order:

- **Needs attention**: permission or form requests.
- **Running**: workers and the main conversation while they run.
- **Main**: the idle main conversation.
- **Finished**: idle workers, with their verdict or native outcome, such as `FAIL`, `no report`, or `interrupted`.
- **Closed**: dismissed rows, so you can restore them.

Hidden workers stay out of the list unless they are open, selected, running, or waiting for input; `/threads` restores them. Type to search. **Enter** opens the highlighted conversation's tab and focuses it. **Ctrl+D** dismisses or restores it; the list stays open and keeps your search and selection. **Esc** closes the list. Configure `threads.activity.choose` and `threads.activity.choose.dismiss` in `cli.json` to change these shortcuts.

The list reads session metadata, input requests already cached from events, and a worker snapshot located at the active conversation's Location, which that conversation already keeps loaded. None of these reads loads another Location. Opening a row loads that session's Location, as any native tab does. OpenCode itself also fetches catalogs for any Location that boots while the TUI is connected, including a worker's, and with MCP servers it keeps revalidating them until the TUI restarts; see [verification evidence](docs/workflows-verification.md#loaded-locations).

Add the terminal plugin to `~/.config/opencode/cli.json`. It takes no options:

```json
{
  "plugins": [{ "package": "@op1/threads" }]
}
```

Version 0.2.6 removed the Activity sidebar, pinning, automatic worker tabs, native tab reordering, and saved-title cleanup. The `activity` and `workerTabs` options from earlier versions are ignored, and their saved client state is no longer read. OpenCode keeps its own tab order. Keep the server plugin in `opencode.json`; server plugin options are not forwarded to the terminal entrypoint. For local development, replace the package name in both files with the clone's absolute path.

| Command | Action |
| --- | --- |
| `/activities`, `ctrl+x j` | Open the Threads list for the current conversation |
| `/threads` | Restore hidden and dismissed managed workers and list them |

`src/activity-theme.ts` accepts both `base`/`muted` and legacy `default`/`subdued` theme tokens. Missing colors use a valid fallback before reaching the renderer: assigning an undefined spinner color aborts the entire frame. The `@opencode/theme` development dependency keeps the host theme types available to TypeScript. Renderer regression tests cover both token shapes and missing colors, including spinner construction and subsequent color updates.

## Verification and limits

Run `bun run typecheck`, `bun test`, and `bun run verify:live`. The live check requires OpenCode V2, Python, and `uv`. It starts a separate local server, a deterministic model endpoint, and a terminal process with isolated configuration and data. It verifies actual tool calls, durable messages, permission restrictions, worker limits, deleted-worker cleanup, and restart behavior. It also checks that running workers appear in the footer indicator without opening tabs, before and after a restart.

Run `bun run verify:footer` to exercise the footer and Threads list. It checks that an idle TUI renders nothing, the running indicator, the needs-input marker for permission and form requests, `ctrl+x j` and `/activities`, grouping, keyboard selection, the dismiss key, and Escape. It also checks that the list shows only the current thread, that focusing a worker shows its main conversation's thread, and that a list-opened worker tab closes after its report, or stays open while focused and closes once you leave it. It covers `/threads` restoration without tabs, the home footer, restart, and that leftover `activity: "sidebar"` and `workerTabs: "auto"` options are ignored.

Before publishing, run `bun run verify:package-ui /absolute/path/to/package.tgz`. The check installs the tarball under `node_modules` outside this checkout and starts a clean TUI without the probe plugin. It verifies the idle footer, the Threads list through `ctrl+x j` and `/activities` with keyboard selection and Escape, the running-worker indicator without a tab, `/workflows` and its result panel, and that a leftover `activity: "sidebar"` option is ignored. It also accepts a published package such as `@op1/threads@0.2.2`. An extracted directory is not equivalent to an installed package for JSX loading.

Run `bun run verify:roles` to verify named profiles against the native server and deterministic model endpoint. It checks actual system prompts, model variants, native delegation, read-only execution, reporting, and role-aware retries.

Run `bun run verify:workflows` to exercise dynamic scripts through real OpenCode tools and sessions. The isolated fixture checks structured pipelines, exact retries, role restrictions, ownership, checkpoints, saved scripts, retained worktrees, service restart, and the terminal navigator.

Pass an extracted package directory to test the release artifact: `bun run verify:live /absolute/path/to/package`.

The native session and plugin index are separate writes. A crash after session creation but before indexing requires an explicit identical spawn retry. A crash after native report admission but before saving the report view requires an explicit report retry; the native coordinator notification remains canonical and is not duplicated. There is no custom outbox or startup task replay.

Snapshots remove stale index entries for deleted sessions. Admission locking assumes one OpenCode server process. Workers that omit `threads_report` have no task verdict; their native execution outcomes remain visible separately.
