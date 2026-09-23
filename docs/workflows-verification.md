# Dynamic workflow verification

The hardening pass targets the seven defects reproduced against `5858de1`, plus storage and timeout races found during integration. The original blanket readiness claim is superseded by these checks and the limits below.

Current verification uses OpenCode `2.0.14`, Bun `1.4.0`, and published `@opencode/codemode` `2.0.12`. Earlier baseline and failing-before evidence used OpenCode `2.0.12`.

## Version 0.2.1 packaging correction

The published 0.2.0 package omitted `tsconfig.json`. In a clean TUI, its TSX modules were compiled with React defaults and failed with `Cannot find package 'react'`. The earlier native suites loaded a test-only TUI probe and did not catch this packaging failure. Their results did not establish that the published terminal entrypoint could load by itself.

Version 0.2.1 includes the existing JSX configuration in the npm package. The focused `verify:package-ui` regression removes the probe before starting the TUI and requires a published package or an extracted package outside the source checkout:

- Published 0.2.0 reproduced the React import failure and missing Activity rail.
- The extracted 0.2.1 tarball, with fresh production dependencies, passed Activity rendering, the `/activities` picker, and `/workflows` command registration.
- Typecheck and all 109 unit tests / 407 assertions passed.
- Independent static review returned **PASS WITH NOTES**, with no release-blocking findings. Artifact execution was verified by the release coordinator.

## Version 0.2.0 release verification

The release adds configurable `workflowConcurrency` and `workflowMaxAgents` defaults for new runs. Explicit run values take precedence, and resumed records retain their original limits. The persisted schema defaults remain 3 concurrent agents and 4 total steps.

Release verification passed on OpenCode 2.0.14:

- `bun run typecheck` and all 109 unit tests / 407 assertions.
- 13 native regression cases against the extracted npm package, including configured 8/8 defaults, explicit 2/2 overrides, eight completed steps, and resumed 3/4 limits.
- 27 native workflow/TUI checks and 27 managed-session checks against the extracted package with fresh production dependencies.
- Independent source review: **PASS WITH NOTES**, with no release-blocking findings.

The packed source hash is `3b5b77f200d79164227c3caeb86eeab95f4c1188b8f7d5c1f689296e1022df72`. The package includes both entrypoints, all runtime worker modules, and the authoring skill with its runtime reference. Local release artifacts are in `.audit/release-0.2.0/`.

## Hardening checkpoint checks

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run typecheck` | Pass | Server, runtime, and terminal types |
| `bun test` | 109 tests, 407 assertions pass | Confinement, replay, checkpoint atomicity, journal limits, deadline races, failed-attempt accounting, and existing Threads behavior |
| `bun run verify:workflow-regressions` | 12 cases pass | Original engine defects, CPU-bound deadline, saved and nested execution, composition helpers, and retained-worktree handoff |
| `bun run verify:roles` | 17 checks pass | Configured profiles, inherited restrictions, role admission, and native delegation |
| `bun run verify:live` | 27 checks pass | Managed-worker lifecycle, reports, limits, native tabs, and restart recovery |
| `bun run verify:workflow-runtime` | Pass | 35 CPU-bound interpreter cancellations, stable native thread count, and idle CPU |
| `python3 scripts/verify-workflows-model.py` | Pass | Model-authored workflow, real VERA readers, validated handoffs, and automatic coordinator notification |
| `bun run verify:workflows` | 27 checks pass | Native workflow lifecycle, permissions, hard restart, uncertain writes, fresh navigator snapshots, keyboard step navigation, and terminal controls |
| `bun run verify:workflow-capacity --steps 1000 --timeout 900` | 8 scenarios pass | Eight concurrent workers, 1,000 unique native sessions, owner pool sharing, controls, deadlines, and cleanup |

Native harnesses use real isolated OpenCode services with deterministic local providers. These fixtures prove execution behavior rather than model quality. The separate real-model check uses the installed plugin and configured VERA profiles.

Each workflow, regression, and capacity harness records a hash of `index.ts`, `tui.ts`, `package.json`, and direct TypeScript sources in `src/`. It rejects source changes during its run. Local artifacts are retained under `.audit/` and are gitignored:

- `workflows/evidence.json` and `workflows/tui.screen.txt`
- `workflow-regressions/evidence.json` and `workflow-regressions/evidence.baseline.json`
- `workflow-capacity/evidence.json`
- `runtime-soak/evidence.json`
- `workflow-model/evidence.json`

The commands regenerate the evidence. Raw transcripts and temporary session directories are not published.

The final workflow, regression, and 1,000-step capacity runs all verified source hash `1414fd9d27ead4a1f955f11168917842aaef043a8eec172b7bd73699aaf3e414`.

## Regression and recovery proof

The native regression harness first reproduced six engine failures on the old source. The runtime tests separately reproduced the synchronous deadline failure. All twelve native cases now pass:

1. Queued agents cannot dispatch after the measured token budget is exhausted.
2. Failed attempts count toward that budget.
3. Answering one checkpoint preserves `waiting` when another remains unanswered.
4. Concurrent checkpoint responses replay in their recorded order after restart.
5. An exposed failure remains a failure on replay, preserving the script's fallback branch.
6. A crash after an accepted report requires explicit same-worker resolution.
7. Saved scripts accept new arguments and retain pinned nested source after restart.
8. Composition helpers execute through the native service.
9. Saved commands register and refresh.
10. A fifth nested workflow boundary fails.
11. A writer and verifier use the same retained worktree.
12. A CPU-bound script reaches its deadline while service RPC remains responsive.

The hard-crash fixture appends one line, blocks before its report, and kills the service. After restart, no provider request is allowed until explicit recovery. Resume preserves the uncertain write. A follow-up asks the same worker to inspect and report its existing effect; the final file still has exactly one line.

Checkpoint responses and settlement order are committed atomically. Focused tests reject oversized responses before persistence, allow a smaller retry, and retain a concurrently committed agent settlement. Legacy external journals remain preserved during migration. Payload admission reserves diagnostic space while retaining the 16 MiB hard limit.

The macOS runtime soak starts and cancels 35 CPU-bound interpreters. Native thread count returns from 25 to 25, and the following idle second consumes 2.157 ms of process CPU. The check uses the real CodeMode interpreter inside terminable Bun workers.

## Independent review

Independent review is a release gate. The initial audit rejected unqualified readiness and supplied executable counterexamples. Later review found a constructor-failure capacity leak, checkpoint journal poisoning, insufficient control headroom, and recovery failures that affected healthy sibling runs. Those findings received focused regression tests and fixes.

The final integrated engine/store review returned **PASS WITH NOTES**, with no blocking findings. Its remaining timer-cleanup finding was reproduced and fixed: a full legacy journal now clears the deadline and notifies the owner even when failure persistence also fails. The focused test preserves both original records.

A separate UI reviewer identified the stale navigator snapshot, then returned **PASS WITH NOTES** after the fix. Explicit refreshes are serialized, background requests coalesce, and responses are guarded across owner navigation. The native terminal suite passes all 27 checks. The A→B→A generation guard has source review but no dedicated navigation regression.

Accepted review limits include unsupported selective deletion of journal records, replay-order mismatches waiting until the run deadline, and reliance on a single loaded scheduler implementation. Checkpoint responses appear both in the checkpoint and its settlement entry, so they count twice toward the journal limit. A nearly full run can reject even a small response while preserving the unanswered checkpoint. Passing implementation-worker reports alone are not treated as independent approval.

## Real-model verification

Run `wfr_8eafe136e930d91c0127b44532be49a4` completed through coordinator `ses_f35910071ffe0I7E0NR3Bzfvfk`, using `vera-core`:

- `vera-operator-readonly`, `openai/gpt-5.6-sol#low`, read `src/workflow-types.ts`.
- `vera-engineer-readonly`, `openai/gpt-5.6-sol#medium`, read `src/workflow-rpc.ts`.
- Validated result: `{"limits":{"concurrency":3,"maxAgents":4},"controls":["pause","resume","stop"]}`.

Both worker models matched their profiles and journal records. Their transcripts contain successful reads and accepted results. After the automatic notification, the coordinator inspected the run and delivered a PASS receipt.

## Execution boundaries

- One OpenCode service with one loaded scheduler implementation owns scheduling. Multiple services or duplicate module instances sharing storage are unsupported.
- Interrupted writes require inspection and same-worker resolution. A missing worker does not authorize repeating its effects.
- Scripts, arguments, and nested scripts are immutable within a run. Changes require a new run key.
- Native failures and explicit `FAIL` or `INCONCLUSIVE` reports prevent completion, even when the script catches them.
- Token budgets govern dispatch using reported usage. In-flight work can exceed the threshold; unmeasured usage blocks further budgeted dispatch.
- Old journals without checkpoint settlement order cannot replay answered checkpoints deterministically. They fail with a diagnostic rather than inventing an order.
- Corrupt and exact-limit legacy records retain their evidence and produce owner-visible diagnostics. A full legacy record may require explicit repair or a new run key.
- Selectively deleting a run record while retaining its legacy completion journal is unsupported. Both records belong to the same run identity.
- An inconsistent settlement order can wait until the run deadline. Recovery does not invent missing completions to make the script advance.
- Interpreter termination stops script CPU work. Parent-side host effects remain subject to native interruption and uncertain-write recovery.
- Worktrees remain available for inspection and integration. The coordinator owns the final engineering verdict.

The [capacity findings](workflow-capacity-findings.md) distinguish cumulative sessions, concurrent agents, interpreter calls, and measured operating limits.
