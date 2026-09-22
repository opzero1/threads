# Dynamic workflow verification

Verified on OpenCode `2.0.12` with Bun `1.4.0`.

## Automated checks

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run typecheck` | Pass | Server, runtime, and terminal types |
| `bun test` | 75 tests, 266 assertions pass | Interpreter confinement, durable state, replay, cancellation, ownership, saved scripts, and existing Threads behavior |
| `bun run verify:workflows` | 24 checks pass | Native sessions, distinct role models and variants, permission enforcement, result repair, worktrees, hard restart, and terminal controls |
| `bun run verify:roles` | 17 checks pass | Configured profiles, inherited restrictions, role admission, and native delegation |
| `bun run verify:live` | 27 checks pass | Existing managed-worker lifecycle, reports, limits, native tabs, and restart recovery |

The native workflow harness hashes `index.ts`, `tui.ts`, `package.json`, and every direct TypeScript source file in `src/`. It rejects a run if those files change during verification. The verified source hash is `b84d6183d2ea68d26984ec6a8155b9c010f41c9c737794bf1ff6f32f1fe595b7`.

The detailed local artifacts are `.audit/workflows/evidence.json`, `.audit/workflows/tui.screen.txt`, and `.audit/workflows/provider-requests.json`. They contain temporary workspace and session identifiers and are not committed. Run the commands above to regenerate them.

## Recovery proof

The native fixture appends one line to a file, blocks before its result report, and kills the OpenCode service. After restart, no provider request is allowed until explicit recovery. Resume leaves the uncertain write interrupted. An authorized follow-up asks the same worker to report the inspected result, after which resume completes with the original worker ID and exactly one appended line.

A separate fixture completes an isolated worktree write, waits at a checkpoint, and restarts the service. Resume activates the cold location's configuration, checks its profile, and returns the cached result without repeating the write.

## Independent review

A read-only auditor from a second model family reviewed confinement, permission enforcement, durable execution, and native evidence. The final verdict was **PASS** after fixes for pause/checkpoint ordering, sticky stop, permit release, delivery serialization, deleted-worker replay, automatic native recovery, and authorization expiry.

The native Threads regression suite also caught a conflicting-report acknowledgment regression. The report path now compares the submitted report with the original synthetic message before accepting a retry. The full native Threads suite passes with that fix.

## Real-model verification

`python3 scripts/verify-workflows-model.py` passed against the installed plugin and existing VERA profiles. The coordinator loaded the authoring skill, wrote its own script, started two parallel read-only steps, and inspected the completed run after its automatic notification.

- Run: `wfr_fa3abb0a913820bc056153e06c6dc044`
- Coordinator: `ses_f36654328ffeZe1BaN23llwapK`, `vera-core`
- `vera-operator-readonly`: `openai/gpt-5.6-sol#low`, read `src/workflow-types.ts`
- `vera-engineer-readonly`: `openai/gpt-5.6-sol#medium`, read `src/workflow-rpc.ts`
- Validated result: `{"limits":{"concurrency":3,"maxAgents":4},"controls":["pause","resume","stop"]}`

Both native worker session models matched the configured profiles and journal records. Their transcripts contain successful source reads and accepted results. The coordinator delivered a final PASS receipt. Detailed local evidence is in `.audit/workflow-model/evidence.json`.

## Execution boundaries

- One OpenCode service owns scheduling. The journal survives service restarts; multiple service processes sharing the same storage are not a supported scheduler topology.
- Interrupted writes require inspection and same-worker resolution. A missing native worker does not authorize repeating its effects.
- Script and nested-script contents are pinned to a run. Changes require a new run key.
- Native failures and explicit `FAIL` or `INCONCLUSIVE` reports prevent workflow completion. Logical retries use validated task data.
- Token budgets govern admission using reported usage. In-flight work can exceed the remaining budget; unmeasured usage blocks further budgeted admission.
- Worktrees remain available for inspection and integration. The root coordinator owns integration and the final engineering verdict.
