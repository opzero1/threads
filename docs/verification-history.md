# Verification history

This page records what the checks behind earlier Threads releases measured and found. It describes the code as it was at each version, not current behavior. For the current rules, see [Work with workers](workers.md), the [workflow runtime contract](../skills/workflow-authoring/references/runtime.md), and [Configuration](configuration.md). To run the checks yourself, see [Development](development.md#run-the-checks).

The native suites use real isolated OpenCode services with deterministic local models. They prove execution behavior, not model quality. Their evidence goes to `.audit/`, which git ignores, and raw transcripts are not published.

This page replaces `dynamic-workflows-plan.md`, `workflows-verification.md`, and `workflow-capacity-findings.md`, which the [decision log](dynamic-workflows-decisions.tsv) cites.

## Version 0.3.0: streaming refresh load

0.3.0 stopped streamed text, reasoning, tool input, compaction deltas, step content, and tool progress from triggering worker and workflow snapshots. A native comparison with 120 saved runs reduced workflow snapshots from 131–135 to 7–9 per streaming window.

Limitations:

- Each remaining workflow snapshot still scans the saved journals, and waiting checkpoints still poll once per second. Journal reads remained.
- Health-request latency was too noisy to show a statistically significant improvement.
- The measurements don't establish the cause of earlier service timeouts.

## Version 0.2.6: release checks

On OpenCode 2.0.18, typecheck and 150 unit tests passed. `verify:footer` passed 25 checks and `verify:package-ui` passed 10 on the release tarball. `verify:live` passed 28 checks and `verify:workflows` passed 29. The layout check ran the tarball at 80, 100, and 120 columns.

The release check found one bug before publishing. An unrelated conversation could show another coordinator's worker count in its footer while its own list showed only the main row. The footer now uses the same coordinator as the list, including in a worker's tab. `verify:footer` covers it with a second conversation and worker in the same folder, plus an open tab for a conversation in another folder.

## Version 0.2.5: Loaded Locations

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
- While idle after eviction, neither build sent a Threads or workflow RPC. The workflow panel's 3-second timer was the one idle exception, and it ran only while the panel was shown or a run could still progress.

## Version 0.2.0: workflow engine

### Design baseline

Workflows were built on Threads `df7686af1c6601ae7d05ae607bc584f185109231` (tag `v0.1.8`) and OpenCode 2.0.12. They live in the Threads package so they share its worker service and ownership checks; the `workflows` tools and RPC stay separate from the `threads` interface. Confined execution uses the published `@opencode/codemode` package, pinned to 2.0.12. Scripts never run through host `eval`, `Function`, or Node `vm`.

The design drew on [Pi Dynamic Workflows](https://github.com/QuintinShaw/pi-dynamic-workflows), [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows), [Claude Code workflows](https://code.claude.com/docs/en/workflows), and [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins). OpenCode and VERA ownership, permissions, and evidence requirements decided the implementation.

### Hardening checks

The hardening pass targeted seven defects reproduced against `5858de1`, plus storage and timeout races found during integration. It ran on OpenCode 2.0.14, Bun 1.4.0, and `@opencode/codemode` 2.0.12.

| Command | Result |
| --- | --- |
| `bun run typecheck` | Pass |
| `bun test` | 109 tests, 407 assertions pass |
| `bun run verify:workflow-regressions` | 12 cases pass |
| `bun run verify:roles` | 17 checks pass |
| `bun run verify:live` | 27 checks pass |
| `bun run verify:workflow-runtime` | Pass: 35 CPU-bound interpreter cancellations, native thread count 25 before and after, 2.157 ms of process CPU in the following idle second |
| `python3 scripts/verify-workflows-model.py` | Pass |
| `bun run verify:workflows` | 27 checks pass |
| `bun run verify:workflow-capacity --steps 1000 --timeout 900` | 8 scenarios pass |

The workflow, regression, and capacity harnesses hash `index.ts`, `tui.ts`, `package.json`, and the TypeScript sources in `src/`, and reject source changes during a run. The final runs all verified source hash `1414fd9d27ead4a1f955f11168917842aaef043a8eec172b7bd73699aaf3e414`.

The regression harness first reproduced six engine failures on the old source, and the runtime tests reproduced a synchronous deadline failure. In the hard-crash fixture, a worker appends one line, blocks before its report, and the service is killed. After restart, no provider request was allowed until explicit recovery, the same worker inspected and reported its existing effect, and the file still had exactly one line.

### Measured capacity

The capacity harness used an isolated OpenCode 2.0.14 service, Bun 1.4.0, and a deterministic local provider, with eight workers configured. It made no paid model calls.

| Measurement | Result |
| --- | --- |
| Sustained run | 1,000 steps, 1,000 unique native worker sessions, ordered results |
| Sustained elapsed time | 229.823 seconds |
| Owner pool | Two runs share eight concurrent workers; 16 unique sessions across both runs |
| Service RSS at eight blocked workers | 565,493,760 bytes, about 539 MiB |
| Pause | 0.242 seconds; eight active workers drain, eight queued workers do not start |
| Stop | 0.120 seconds; eight active native requests interrupted |
| One-second worker deadline | Failure observed after 1.321 seconds, including dispatch and teardown |
| One-second run deadline | Failure observed after 1.149 seconds |
| Log retention | Newest 200 of 205 entries retained |
| Cleanup | Zero active sessions; all 1,016 worker identities from the sustained and shared-pool scenarios retained |

The run also measured a cumulative host-call cap that later versions removed.

Limitations:

- The timings describe a deterministic provider on one machine, not real-model throughput.
- RSS is one service sample, not peak memory.
- The result doesn't establish capacity at 32 workers, across multiple owners, or over a seven-day run. Don't treat the 32-worker ceiling of `maxWorkers` as a verified operating target.
- The runtime soak checks CPU termination and native thread cleanup. It doesn't load-test 64 simultaneous interpreters.
- The inspected OpenCode V2 schema exposed no global native-session concurrency ceiling. That isn't proof of unlimited capacity.

From these results: use at most eight workflow workers per owner, and raise `maxWorkers` above its default only for an isolated load or known I/O-bound work. Prefer batches of 100–250 concise steps. Store large evidence in artifact files and return paths, so reports stay far below their size limit.

### Independent review

The first audit rejected an unqualified readiness claim and supplied executable counterexamples. Later reviews found a constructor-failure capacity leak, checkpoint journal poisoning, too little control headroom, and recovery failures that affected healthy sibling runs. Each finding got a focused regression test and a fix. The final engine and store review returned **PASS WITH NOTES** with no blocking findings. A separate UI review found a stale navigator snapshot and returned **PASS WITH NOTES** after the fix; its A→B→A generation guard has source review but no dedicated navigation regression.

### Real-model verification

Run `wfr_8eafe136e930d91c0127b44532be49a4` completed through coordinator `ses_f35910071ffe0I7E0NR3Bzfvfk`, using `vera-core`. `vera-operator-readonly` (`openai/gpt-5.6-sol#low`) read `src/workflow-types.ts`, and `vera-engineer-readonly` (`openai/gpt-5.6-sol#medium`) read `src/workflow-rpc.ts`. The validated result listed the run limits of that version and the pause, resume, and stop controls. Both worker models matched their profiles and journal records. After the automatic notification, the coordinator inspected the run and delivered a PASS receipt.
