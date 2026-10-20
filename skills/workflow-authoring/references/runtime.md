# Workflow runtime contract

Scripts run in OpenCode's confined Code Mode interpreter inside a terminable Bun worker. When a deadline is supplied, the parent service enforces it, including during synchronous script work. Scripts cannot import modules or use host filesystem, process, network, clock, or randomness APIs. Agents inspect the outside world and return recorded data. Use arguments for timestamps and other variable inputs.

Keep each result below 1 MiB and the combined run journal below 16 MiB. Payload admission reserves space for control metadata and bounded failure diagnostics, so usable payload capacity is lower. Return concise structured findings and artifact paths instead of complete file contents. Run lists omit the result. Completion notifications include the run's total usage and the first 2,000 characters of the result as JSON text, marked `…[truncated]` when cut off; inspect a run to read the full result.

## Script shape

The first statement is `export const meta = { name: "name", description: "description" }`. Metadata contains literal values. An optional `phases` array contains objects with a `title`.

The body supports top-level `await`, ordinary data transformations, branching, and bounded loops. Return a JSON value. Intermediate agent results stay in script variables and the durable journal.

## Agent steps

`await agent(prompt, options)` returns the validated `result` submitted by its worker. Options are:

| Field | Meaning |
| --- | --- |
| `key` | Required unique, stable step name. Include the item and round when using loops. |
| `agent` | Required configured OpenCode agent ID. |
| `label` | Optional display title. |
| `phase` | Optional phase override. |
| `schema` | Optional JSON Schema for the result. Invalid schemas fail before dispatch. |
| `access` | `read` by default: only the profile's permitted read, glob, grep, webfetch, websearch, and skill tools. `write` permits the selected profile's other tools. |
| `isolation` | `shared` by default, or `worktree` for an isolated checkout that stays while the run can resume. Creating a worktree requires `access: "write"`; later readers can use its returned `directory`. |
| `directory` | Optional existing directory beneath the owner session's directory, in one of its registered worktrees, or inside a granted path. Symlinks are resolved before containment checks. For another repository beneath that directory, worktree isolation uses the source repository's project and configured worktree strategy. A directory that only a grant admits has [extra conditions](#external-directories). |
| `paths` | Optional list of up to 16 existing absolute directories outside the worker's directory that it may use without asking. Each path and its subdirectories are granted for `external_directory` only. |
| `timeoutMs` | Optional user-requested step timeout, bounded by any supplied run deadline. |

Workers submit `workflows_result({ verdict, summary, evidence, result })`. Invalid results return a validation error so the worker can repair its output. A native execution that ends without a result has no task verdict.

Profile restrictions and the coordinator's restrictions still apply. Read access blocks other plugin and MCP tools, including those with side effects, even if the selected profile permits them. Workflow workers cannot delegate. Selecting `access: "write"` does not grant permissions that the selected profile lacks.

## External directories

OpenCode checks `external_directory` when a tool uses a path outside the worker's project. For write steps, a coordinator `ask` for that check stays an approval request in the worker's tab instead of becoming a denial. The Threads footer and list mark the worker as needing input, and the step waits for the answer within its timeout. A role that denies the directory still denies it. A directory that the coordinator and the role both allow with the same rule, such as OpenCode's own tool-output and configuration directories, stays allowed. Other inherited `ask` rules still become denials. Read steps follow their role's `external_directory` rules, as before.

`paths` grants take effect after these restrictions, so they replace an approval request or a role's catch-all `* * deny` for the granted directories. They do not add tools: read access keeps edits and commands denied. Explicit `external_directory` denies from the coordinator or the role still win inside a grant. A step fails before dispatch when such a deny blocks a granted directory itself, when a path is not an absolute existing directory, when it is the filesystem root, or when it contains `*`, `?`, or a POSIX backslash.

A step whose `directory` is inside a granted path, rather than in the owner's project or its worktrees, runs in that directory's project: the enclosing git worktree, or the directory itself outside a repository. OpenCode does not check `external_directory` inside a worker's project, so an explicit deny there would stop applying. The step fails before admission unless that project is inside a granted path and no explicit `external_directory` deny from the coordinator or the role matches the project or any path beneath it. With worktree isolation, the new checkout must also be clear of those denies. A deny pattern that starts with `*`, such as `*/secret/*`, can match beneath any directory, so it blocks every such step. Keep that step in the owner's project and list the directory in `paths` instead.

With worktree isolation, the worker runs under its role as configured at the checkout. OpenCode also applies `opencode.json` files from the checkout's parent directories, so those rules can differ from the role's rules at the source. Just before the worker's first prompt, the runner reads the role where the worker runs and the coordinator's current rules, and it derives the worker's permissions from them. For a step that only a grant admits, it also repeats the project check there. If the check fails, the step fails and the worker is not prompted.

The runner resolves symlinks, removes duplicates, sorts the list, and records it in the step input and in the worker's `opThreadsPaths` metadata. The resolved list is part of the step identity. If a resumed run's paths resolve to different directories, the step fails with `resumed with different input` rather than silently changing its grant. A granted directory that no longer exists also fails the step on resume, including a completed one, because its identity cannot be checked.

## Composition

- `parallel(thunks)` runs async functions concurrently and returns results in input order.
- `pipeline(items, ...stages)` runs each item through its stages independently. A fast item does not wait for slower items between stages.
- `await phase(title)` records a display phase.
- `await log(message)` records a bounded progress message.
- `workflow(name, args)` invokes a saved workflow within the parent's limits.
- `retry(thunk, { attempts }?)` retries logical or validation errors until success, cancellation, or a supplied attempt limit. New runs have no default attempt limit. Give each agent attempt a distinct step key. Return expected negative findings as validated data, then let the validator decide whether another attempt is useful. A native execution failure or an explicit `FAIL`/`INCONCLUSIVE` report remains an unresolved failure and prevents the run from passing, even when caught by the script. Inspect uncertain writes before starting a replacement run.
- `gate(thunk, validator, { attempts }?)` repeats until the validator accepts, cancellation occurs, or a supplied attempt limit is reached. New runs have no default attempt limit. The validator returns a boolean or `{ ok: boolean, feedback?: string }`. A truthy object without `ok: true` does not pass.
- `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` accumulates unique findings until discovery stops producing new items. `round` and `key` are required; `key` is a property name or identity function. The default termination condition is two consecutive empty rounds. New runs have no default maximum round count. Reaching a supplied maximum returns the accumulated findings.
- `checkpoint(prompt, { key, reviewer? })` records a question and waits for an explicit response through the run controls. `reviewer` is `"human"` by default; `"coordinator"` allows heartbeat reminders for an authorized coordinator review. Neither value supplies a response or changes the control permissions. The response becomes recorded input on resume. Responses are limited to 1 MiB and must fit in the aggregate journal. Rejected responses leave the checkpoint unanswered so a smaller response can be submitted.

Errors remain errors unless the script explicitly handles them. Do not discard failed items or substitute a passing result for missing evidence.

## Start and control

`workflows_start` accepts exactly one of `script` or saved `name`, plus a unique task `key`, optional JSON `args`, and limits:

| Limit | Default | Range |
| --- | --- | --- |
| `concurrency` | 3 | 1–8 |
| `maxAgents` | Unset | 1–1000 when supplied |
| `agentTimeoutMs` | Unset | 1 second–7 days when supplied |
| `timeoutMs` | Unset | 1 second–7 days when supplied |
| `tokenBudget` | Unset | Positive integer |

The plugin option `workflowConcurrency` sets concurrency for new runs. An explicitly configured `workflowMaxAgents` supplies a user-selected total-step limit. The registered `workflows_start` schema advertises configured values. Existing runs retain their original limits, including historical defaults omitted from compacted records. If a total-step limit is supplied, it must be at least as large as the requested concurrency to use that concurrency fully.

Task budgets are opt-in. Agents omit `tokenBudget`, `maxAgents`, `agentTimeoutMs`, and `timeoutMs` unless the user supplies a limit. If the user requests a budget without a value, the agent asks for that value. Agents do not estimate replacement values or insert hidden defaults. With no supplied budget, that dimension is unbounded. Concurrency, worker capacity, payload bounds, and cancellation still apply.

`tokenBudget` measures cumulative native input and output tokens across worker turns. It is an admission threshold, not a hard generation cap: workers already running can exceed it before the next dispatch checks their usage.

When a total-step budget is supplied, the cumulative host-call cap is `maxAgents * 8 + 100`, including agent, phase, log, checkpoint, and nested-workflow calls. Without that budget, there is no derived cumulative cap. Nested saved workflows share any supplied parent budgets. Nesting is limited to four child levels.

Helper bounds (`attempts`, `maxRounds`, and `consecutiveEmpty`) must be safe positive integers no greater than 1,000. Arguments, host-call payloads, and results are each limited to 1 MiB; error diagnostics are capped at 8 KiB. The runtime module allows 64 simultaneous interpreter calls, including nested calls, and rejects excess calls immediately. This is separate from the agent concurrency limit.

Agents omit helper `attempts` and `maxRounds` unless the user supplies them. A recorded helper policy preserves the original three-attempt and ten-round defaults for older runs. New saved and nested executions inherit the parent run's policy.

The configured Threads worker limit also applies across simultaneous runs owned by one coordinator. Its default is four workers. A token budget checks recorded usage at dispatch, including failed and interrupted attempts. Already-running agents can exceed the remaining budget. Unreported usage is marked unmeasured and blocks further budgeted dispatch.

The same start key and identical input identify the same run. Start retries do not restart completed or stopped runs. Pause stops new scheduling and drains active steps. Stop interrupts active work. Resume uses the same recorded script and arguments, reconciles existing sessions, and reuses completed results. A changed step request under an existing key fails rather than returning a stale result. Save edits as a new workflow run.

After upgrading from finite defaults, an old start request that omitted its budgets no longer has the same input fingerprint. Resume the existing run through `tools.workflows.control`, or supply its original recorded limits for an exact start retry.

A service restart leaves interrupted work available for explicit resume. Worktrees and session evidence are retained. A missing result after an interrupted write requires inspection; it does not prove that no write occurred.

When a run completes, fails, or stops, Threads removes each step worktree that has no uncommitted or untracked changes, no commits outside a branch, tag, or remote, no nested worktree, and no running worker. It never forces removal or deletes branches. A later step whose `directory` is in a removed checkout fails. The run's `worktreeCleanup` records what it removed and kept. The `workflowWorktreeCleanup` plugin option turns this off. `tools.workflows.prune` lists leftover worktrees of finished runs in the project and removes the clean ones with `apply: true`. Running, waiting, paused, and interrupted runs keep their worktrees.

Unanswered checkpoints and interruptions send durable, deduplicated notices to the owner. Checkpoint notices include the exact key and prompt. Each interruption has a separate notice. Delivery failures retry at a later boundary, recovery, or inspection with the same message ID. A notice never supplies a checkpoint response or resumes the run. Resuming after the original deadline interrupts retained workers and fails the run.

For an uncertain write, inspect its retained worker and directory. Use `threads_send` to ask that same worker to verify the existing effects and submit `workflows_result` without repeating completed actions. After its native execution finishes, resume the workflow. A missing worker session is not permission to replay its writes in a new session.

Follow-ups produce a separate completion notice keyed to the admitted message. That notice reports native execution, not acceptance, and never replaces the worker's original report. If the worker already submitted a result, inspect the follow-up evidence separately. Compaction can hide an unrecorded completion from the SDK's context reader; that case remains unresolved rather than replaying work.

Nested saved scripts are pinned to their run. Agent successes, exposed failures, and checkpoint responses replay in their original settlement order. An exposed failure cannot become a success during replay. If a selected profile's model, instructions, or permissions change, start a new run rather than treating its old result as evidence from the new profile.

Legacy journals without checkpoint settlement order cannot deterministically resume an answered checkpoint. Such runs fail with a diagnostic and require a new run key. A corrupt or already-full legacy record remains preserved and produces an owner-visible diagnostic without blocking healthy sibling runs. An exact-limit legacy record may need explicit repair before any further control metadata fits.

Checkpoint responses are stored in both checkpoint state and settlement order, so their bytes count twice toward the journal limit. A run too full to accept a response remains unanswered; use a smaller response or a new run key. An inconsistent settlement order may wait until the configured run deadline.

## Saved workflows

`tools.workflows.save` writes a run's script to `.opencode/workflows/<name>.js` in the current directory or to `workflows/<name>.js` under the user's OpenCode configuration. Existing files are not overwritten. Project workflows take precedence over user workflows of the same name.

Use `tools.workflows.saved` to list scripts and `/workflow-<name>` to ask the agent to invoke one with arguments. `/workflow-run <task>` asks the current agent to author a workflow. `/workflows` opens the terminal run navigator.

After editing saved files directly, use `/workflow-refresh` to reload their commands. The saved names `run` and `refresh` are reserved for built-in workflow commands.
