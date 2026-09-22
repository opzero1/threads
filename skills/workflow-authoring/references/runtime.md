# Workflow runtime contract

Scripts run in OpenCode's confined Code Mode interpreter. They cannot import modules or use host filesystem, process, network, clock, or randomness APIs. Agents inspect the outside world and return recorded data. Use arguments for timestamps and other variable inputs.

Keep each result below 1 MiB and the combined run journal below 16 MiB. Return concise structured findings and artifact paths instead of complete file contents. Run lists and completion notifications omit the full result; inspect a run to read it.

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
| `access` | `read` by default. `write` permits the selected profile's write tools. |
| `isolation` | `shared` by default, or `worktree` for a retained isolated checkout. |
| `directory` | Optional explicit working directory. |
| `timeoutMs` | Optional step timeout, bounded by the run's execution policy. |

Workers submit `workflows_result({ verdict, summary, evidence, result })`. Invalid results return a validation error so the worker can repair its output. A native execution that ends without a result has no task verdict.

Profile restrictions and the coordinator's restrictions still apply. Workflow workers cannot delegate. Selecting `access: "write"` does not grant permissions that the selected profile lacks.

## Composition

- `parallel(thunks)` runs async functions concurrently and returns results in input order.
- `pipeline(items, ...stages)` runs each item through its stages independently. A fast item does not wait for slower items between stages.
- `await phase(title)` records a display phase.
- `await log(message)` records a bounded progress message.
- `workflow(name, args)` invokes a saved workflow within the parent's limits.
- `retry(thunk, { attempts })` bounds semantic retries. Give each agent attempt a distinct step key. Inspect uncertain writes before retrying them.
- `gate(thunk, validator, { attempts })` repeats until the validator accepts or attempts run out. The validator returns a boolean or `{ ok: boolean, feedback?: string }`. A truthy object without `ok: true` does not pass.
- `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` accumulates unique findings until discovery stops producing new items.
- `checkpoint(prompt, { key })` records a question and waits for an explicit response through the run controls. The response becomes recorded input on resume.

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

The configured Threads worker limit also applies. A token budget checks recorded usage before admitting more agents. Already-running agents can exceed the remaining budget. Unreported usage is marked unmeasured rather than represented as an exact zero.

The same start key and identical input identify the same run. Start retries do not restart completed or stopped runs. Pause stops new scheduling and drains active steps. Stop interrupts active work. Resume uses the same recorded script and arguments, reconciles existing sessions, and reuses completed results. A changed step request under an existing key fails rather than returning a stale result. Save edits as a new workflow run.

A service restart leaves interrupted work available for explicit resume. Worktrees and session evidence are retained. A missing result after an interrupted write requires inspection; it does not prove that no write occurred.

## Saved workflows

`workflows_save` writes a run's script to `.opencode/workflows/<name>.js` in the current directory or to `workflows/<name>.js` under the user's OpenCode configuration. Existing files are not overwritten. Project workflows take precedence over user workflows of the same name.

Use `workflows_saved` to list scripts and `/workflow-<name>` to ask the agent to invoke one with arguments. `/workflow-run <task>` asks the current agent to author a workflow. `/workflows` opens the terminal run navigator.
