# Workflow runtime contract

Scripts run in OpenCode's confined Code Mode interpreter inside a terminable Bun worker. The parent service enforces the deadline, including during synchronous script work. Scripts cannot import modules or use host filesystem, process, network, clock, or randomness APIs. Agents inspect the outside world and return recorded data. Use arguments for timestamps and other variable inputs.

Keep each result below 1 MiB and the combined run journal below 16 MiB. Payload admission reserves space for control metadata and bounded failure diagnostics, so usable payload capacity is lower. Return concise structured findings and artifact paths instead of complete file contents. Run lists and completion notifications omit the full result; inspect a run to read it.

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
| `isolation` | `shared` by default, or `worktree` for a retained isolated checkout. Creating a worktree requires `access: "write"`; later readers can use its returned `directory`. |
| `directory` | Optional existing directory inside the owner project or one of its registered worktrees. Symlinks are resolved before containment checks. |
| `timeoutMs` | Optional step timeout, bounded by the run's execution policy. |

Workers submit `workflows_result({ verdict, summary, evidence, result })`. Invalid results return a validation error so the worker can repair its output. A native execution that ends without a result has no task verdict.

Profile restrictions and the coordinator's restrictions still apply. Read access blocks other plugin and MCP tools, including those with side effects, even if the selected profile permits them. Workflow workers cannot delegate. Selecting `access: "write"` does not grant permissions that the selected profile lacks.

## Composition

- `parallel(thunks)` runs async functions concurrently and returns results in input order.
- `pipeline(items, ...stages)` runs each item through its stages independently. A fast item does not wait for slower items between stages.
- `await phase(title)` records a display phase.
- `await log(message)` records a bounded progress message.
- `workflow(name, args)` invokes a saved workflow within the parent's limits.
- `retry(thunk, { attempts })` bounds logical or validation retries, with three attempts by default. Give each agent attempt a distinct step key. Return expected negative findings as validated data, then let the validator decide whether another attempt is useful. A native execution failure or an explicit `FAIL`/`INCONCLUSIVE` report remains an unresolved failure and prevents the run from passing, even when caught by the script. Inspect uncertain writes before starting a replacement run.
- `gate(thunk, validator, { attempts })` repeats until the validator accepts or attempts run out, with three attempts by default. The validator returns a boolean or `{ ok: boolean, feedback?: string }`. A truthy object without `ok: true` does not pass.
- `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` accumulates unique findings until discovery stops producing new items. `round` and `key` are required; `key` is a property name or identity function. Defaults are two consecutive empty rounds and ten maximum rounds. Reaching the maximum returns the accumulated findings.
- `checkpoint(prompt, { key })` records a question and waits for an explicit response through the run controls. The response becomes recorded input on resume. Responses are limited to 1 MiB and must fit in the aggregate journal. Rejected responses leave the checkpoint unanswered so a smaller response can be submitted.

Errors remain errors unless the script explicitly handles them. Do not discard failed items or substitute a passing result for missing evidence.

## Start and control

`workflows_start` accepts exactly one of `script` or saved `name`, plus a unique task `key`, optional JSON `args`, and limits:

| Limit | Default | Range |
| --- | --- | --- |
| `concurrency` | 3 | 1–8 |
| `maxAgents` | 4 | 1–1000 |
| `agentTimeoutMs` | 30 minutes | 1 second–7 days |
| `timeoutMs` | 24 hours | 1 second–7 days |
| `tokenBudget` | Unset | Positive integer |

`tokenBudget` measures cumulative native input and output tokens across worker turns. It is an admission threshold, not a hard generation cap: workers already running can exceed it before the next dispatch checks their usage. Multi-turn code investigation can consume much more than the final answer's token count. Choose the threshold for the whole run, including review steps, or omit it and use the agent and time limits.

The cumulative host-call cap is `maxAgents * 8 + 100`, including agent, phase, log, checkpoint, and nested-workflow calls. Nested saved workflows share that cap and the parent agent budget. Nesting is limited to four child levels.

Helper bounds (`attempts`, `maxRounds`, and `consecutiveEmpty`) must be safe positive integers no greater than 1,000. Arguments, host-call payloads, and results are each limited to 1 MiB; error diagnostics are capped at 8 KiB. The runtime module allows 64 simultaneous interpreter calls, including nested calls, and rejects excess calls immediately. This is separate from the agent concurrency limit.

The configured Threads worker limit also applies across simultaneous runs owned by one coordinator. Its default is four workers. A token budget checks recorded usage at dispatch, including failed and interrupted attempts. Already-running agents can exceed the remaining budget. Unreported usage is marked unmeasured and blocks further budgeted dispatch.

The same start key and identical input identify the same run. Start retries do not restart completed or stopped runs. Pause stops new scheduling and drains active steps. Stop interrupts active work. Resume uses the same recorded script and arguments, reconciles existing sessions, and reuses completed results. A changed step request under an existing key fails rather than returning a stale result. Save edits as a new workflow run.

A service restart leaves interrupted work available for explicit resume. Worktrees and session evidence are retained. A missing result after an interrupted write requires inspection; it does not prove that no write occurred.

For an uncertain write, inspect its retained worker and directory. Use `threads_send` to ask that same worker to verify the existing effects and submit `workflows_result` without repeating completed actions. After its native execution finishes, resume the workflow. A missing worker session is not permission to replay its writes in a new session.

Nested saved scripts are pinned to their run. Agent successes, exposed failures, and checkpoint responses replay in their original settlement order. An exposed failure cannot become a success during replay. If a selected profile's model, instructions, or permissions change, start a new run rather than treating its old result as evidence from the new profile.

Legacy journals without checkpoint settlement order cannot deterministically resume an answered checkpoint. Such runs fail with a diagnostic and require a new run key. A corrupt or already-full legacy record remains preserved and produces an owner-visible diagnostic without blocking healthy sibling runs. An exact-limit legacy record may need explicit repair before any further control metadata fits.

Checkpoint responses are stored in both checkpoint state and settlement order, so their bytes count twice toward the journal limit. A run too full to accept a response remains unanswered; use a smaller response or a new run key. An inconsistent settlement order may wait until the configured run deadline.

## Saved workflows

`workflows_save` writes a run's script to `.opencode/workflows/<name>.js` in the current directory or to `workflows/<name>.js` under the user's OpenCode configuration. Existing files are not overwritten. Project workflows take precedence over user workflows of the same name.

Use `workflows_saved` to list scripts and `/workflow-<name>` to ask the agent to invoke one with arguments. `/workflow-run <task>` asks the current agent to author a workflow. `/workflows` opens the terminal run navigator.

After editing saved files directly, use `/workflow-refresh` to reload their commands. The saved names `run` and `refresh` are reserved for built-in workflow commands.
