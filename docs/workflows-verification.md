# Verification record

This page records what the checks behind Threads releases showed. To run the checks yourself, see [Development](development.md#run-the-checks).

The native suites use real isolated OpenCode services with deterministic local models. They prove execution behavior, not model quality. The separate [real-model check](#real-model-verification) uses the installed plugin and configured VERA profiles.

## Version 0.2.6

On OpenCode 2.0.18:

- Typecheck and 150 unit tests passed.
- `verify:footer` passed 25 checks, and `verify:package-ui` passed 10 on the release tarball.
- `verify:live` passed 28 checks, and `verify:workflows` passed 29.

The layout check ran the release tarball at 80, 100, and 120 columns, with 23 layout and keyboard checks at each width. Titles use the full row width. Worker statuses stay visible with a two-cell gap.

The release check found one bug before publishing. An unrelated conversation could show another coordinator's worker count in its footer, while its own list showed only the main row. The footer now uses the same coordinator as the list, including in a worker's tab.

The `verify:footer` fixture adds a second conversation with its own worker in the same folder, plus an open tab for a conversation in another folder. The list must leave both out while workers are idle, running, or waiting for input, and while a worker is focused. The suite also checks that:

- A dismissed worker stays under **Closed** after a terminal restart, until `/threads` restores it.
- Deleting a worker's session removes its row from the open list.
- A hidden worker's tab, opened after its report, stays open while focused and closes once focus moves away.
- Options left over from earlier versions open no worker tab and add no sidebar, including for a newly started worker.

## Loaded Locations

These runs explain [why Threads doesn't open worker tabs](how-it-works.md#why-threads-doesnt-open-tabs). They used OpenCode 2.0.16 and compared a build that opened worker tabs automatically (`9abdba3`) with the footer build that replaced it.

The fixture has a coordinator tab and two ordinary tabs. The coordinator starts one worker in its own folder, and the worker reports `FAIL`. Counts are `GET /api/debug/location` entries. After each phase, every Location was evicted and observed for 30 seconds.

| Build | MCP servers | Idle | Worker running | Worker finished, after eviction | Fresh terminal | Fresh terminal, after eviction |
| --- | --- | --- | --- | --- | --- | --- |
| Automatic tabs | none | 4 | 3, worker tab open | 0 | 5, worker included | 0 |
| Footer | none | 4 | 3, no worker tab | 0 | 4, worker excluded | 0 |
| Automatic tabs | 3 per Location | 4 | 5, worker tab open | 5, worker rebooted | 5, worker included | 5, worker rebooted |
| Footer | 3 per Location | 4 | 5, no worker tab | 5, worker rebooted | 4, worker excluded | 4, worker not rebooted |

- With automatic tabs, a fresh terminal loads the finished worker's Location, because its tab stays open and OpenCode prefetches every tab. With MCP servers, that Location restarts its three servers at every terminal start and reboots after each eviction. The footer build opens no worker tab. A fresh terminal makes one request about the worker, `GET /api/session/:id`, which doesn't load a Location.
- In the terminal session during which the worker ran, both builds end with the worker's Location revalidated when MCP servers are configured. OpenCode's terminal fetches agents, commands, models, providers, skills, and MCP resources for any Location that publishes update events while it is connected. After eviction, the terminal's own `GET /api/mcp/resource` booted that Location again within 0.5 seconds. No Threads request was involved, so Threads can't prevent this. An upstream fix would ignore `mcp.*.changed` for a Location during or after its `location.shutdown`, or revalidate only Locations that a visible view reads.
- While idle after eviction, neither build sent a Threads or workflow RPC.

The workflow panel's timer is the one idle exception. It refreshes every 3 seconds only while the panel is shown, or while a run can still progress. `ui.panel.current()` returns only the calling plugin's panel, and OpenCode closes a panel when the route leaves its session.

## Workflow hardening checks

The hardening pass targeted seven defects reproduced against `5858de1`, plus storage and timeout races found during integration. It ran on OpenCode 2.0.14, Bun 1.4.0, and `@opencode/codemode` 2.0.12.

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run typecheck` | Pass | Server, runtime, and terminal types |
| `bun test` | 109 tests, 407 assertions pass | Confinement, replay, checkpoint atomicity, journal limits, deadline races, failed-attempt accounting, and existing Threads behavior |
| `bun run verify:workflow-regressions` | 12 cases pass | Original engine defects, CPU-bound deadline, saved and nested execution, composition helpers, and retained-worktree handoff |
| `bun run verify:roles` | 17 checks pass | Configured profiles, inherited restrictions, role admission, and native delegation |
| `bun run verify:live` | 27 checks pass | Worker lifecycle, reports, limits, native tabs, and restart recovery |
| `bun run verify:workflow-runtime` | Pass | 35 CPU-bound interpreter cancellations, stable native thread count, and idle CPU |
| `python3 scripts/verify-workflows-model.py` | Pass | Model-authored workflow, real VERA readers, validated handoffs, and automatic coordinator notification |
| `bun run verify:workflows` | 27 checks pass | Workflow lifecycle, permissions, hard restart, uncertain writes, fresh navigator snapshots, keyboard step navigation, and terminal controls |
| `bun run verify:workflow-capacity --steps 1000 --timeout 900` | 8 scenarios pass | Eight concurrent workers, 1,000 unique native sessions, owner pool sharing, controls, deadlines, and cleanup |

Each workflow, regression, and capacity harness records a hash of `index.ts`, `tui.ts`, `package.json`, and the TypeScript sources in `src/`. It rejects source changes during its run. The final workflow, regression, and 1,000-step capacity runs all verified source hash `1414fd9d27ead4a1f955f11168917842aaef043a8eec172b7bd73699aaf3e414`.

The harnesses write evidence under `.audit/`, which git ignores. Rerun the commands to regenerate it. Raw transcripts and temporary session folders are not published.

## Regression and recovery proof

The native regression harness first reproduced six engine failures on the old source. The runtime tests separately reproduced the synchronous deadline failure. All twelve native cases now pass:

1. Queued agents can't dispatch after the measured token budget is spent.
2. Failed attempts count toward that budget.
3. Answering one checkpoint keeps the run `waiting` while another checkpoint is unanswered.
4. Concurrent checkpoint responses replay in their recorded order after restart.
5. An exposed failure stays a failure on replay, so the script's fallback branch still runs.
6. A crash after an accepted report requires explicit resolution by the same worker.
7. Saved scripts accept new arguments and keep their pinned nested source after restart.
8. Composition helpers run through the native service.
9. Saved commands register and refresh.
10. A fifth nested workflow boundary fails.
11. A writer and a verifier use the same retained worktree.
12. A CPU-bound script reaches its deadline while the service RPC stays responsive.

The hard-crash fixture appends one line, blocks before its report, and kills the service. After restart, no provider request is allowed until explicit recovery. Resume keeps the uncertain write. A follow-up asks the same worker to inspect and report its existing effect. The final file still has exactly one line.

Checkpoint responses and settlement order are committed atomically. Focused tests reject oversized responses before they are saved, allow a smaller retry, and keep a concurrently committed agent settlement. Legacy external journals are preserved during migration. Payload admission reserves space for diagnostics within the 16 MiB hard limit.

The macOS runtime soak starts and cancels 35 CPU-bound interpreters. The native thread count returns from 25 to 25, and the following idle second uses 2.157 ms of process CPU. The check uses the real Code Mode interpreter inside terminable Bun workers.

## Independent review

Independent review is a release gate. The first audit rejected an unqualified readiness claim and supplied executable counterexamples. Later reviews found a constructor-failure capacity leak, checkpoint journal poisoning, too little control headroom, and recovery failures that affected healthy sibling runs. Each finding got a focused regression test and a fix.

The final engine and store review returned **PASS WITH NOTES** with no blocking findings. Its remaining timer-cleanup finding was reproduced and fixed. A full legacy journal now clears the deadline and notifies the owner, even when saving the failure also fails.

A separate UI review found a stale navigator snapshot, then returned **PASS WITH NOTES** after the fix. Explicit refreshes run one at a time, background requests coalesce, and responses are guarded across owner navigation. The A→B→A generation guard has source review but no dedicated navigation regression.

Accepted limits from review:

- Deleting individual journal records is unsupported.
- A replay-order mismatch waits until the run deadline.
- Scheduling relies on a single loaded scheduler implementation.
- Checkpoint responses are stored twice, so they count twice toward the journal limit. A nearly full run can reject even a small response, and the checkpoint stays unanswered.
- Passing reports from implementation workers alone don't count as independent approval.

## Real-model verification

Run `wfr_8eafe136e930d91c0127b44532be49a4` completed through coordinator `ses_f35910071ffe0I7E0NR3Bzfvfk`, using `vera-core`:

- `vera-operator-readonly`, `openai/gpt-5.6-sol#low`, read `src/workflow-types.ts`.
- `vera-engineer-readonly`, `openai/gpt-5.6-sol#medium`, read `src/workflow-rpc.ts`.
- Validated result: `{"limits":{"concurrency":3,"maxAgents":4},"controls":["pause","resume","stop"]}`.

Both worker models matched their profiles and journal records. Their transcripts contain successful reads and accepted results. After the automatic notification, the coordinator inspected the run and delivered a PASS receipt.

## Execution boundaries

- One OpenCode service with one loaded scheduler implementation owns scheduling. Multiple services, or duplicate module instances that share storage, are unsupported.
- Interrupted writes require inspection and resolution by the same worker. A missing worker doesn't authorize repeating its effects.
- Scripts, arguments, and nested scripts can't change within a run. Changes require a new run key.
- Native failures and explicit `FAIL` or `INCONCLUSIVE` reports prevent completion, even when the script catches them.
- Token budgets govern dispatch using reported usage. Work already running can exceed the threshold. Unmeasured usage blocks further budgeted dispatch.
- Old journals without checkpoint settlement order can't replay answered checkpoints deterministically. They fail with a diagnostic instead of inventing an order.
- Corrupt and exact-limit legacy records keep their evidence and produce diagnostics that the owner can see. A full legacy record may need explicit repair or a new run key.
- Deleting a run record while keeping its legacy completion journal is unsupported. Both records belong to the same run identity.
- An inconsistent settlement order can wait until the run deadline. Recovery doesn't invent missing completions to make the script advance.
- Interpreter termination stops script CPU work. Host effects on the parent side remain subject to native interruption and uncertain-write recovery.
- Worktrees stay available for inspection and integration. The coordinator owns the final engineering verdict.

The [capacity findings](workflow-capacity-findings.md) separate cumulative sessions, concurrent agents, interpreter calls, and measured operating limits.
