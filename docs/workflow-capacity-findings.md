# Workflow capacity findings

The native load harness uses an isolated OpenCode service and a deterministic local provider. It makes no paid model calls. The package uses `@opencode/plugin` and `@opencode/schema` 2.0.7, with `@opencode/codemode` 2.0.12.

## Exact bounds

- Workflow concurrency defaults to 3 and accepts 1–8.
- A workflow defaults to 4 agents and accepts 1–1,000 total agent steps.
- Worker and run timeouts accept 1 second through 7 days. Defaults are 30 minutes per worker and 24 hours per run.
- Threads `maxWorkers` defaults to 4 and accepts 1–32. It is both the unfinished managed-worker admission limit and the owner-wide workflow execution limit. A run's effective concurrency is therefore `min(concurrency, maxWorkers)`, with `maxWorkers` shared by simultaneous workflows owned by one session.
- Workflow workers are top-level native OpenCode sessions. Workflow workers cannot delegate, start workflows, or spawn managed workers. Managed Threads workers may use native subagents if their permissions allow it, but cannot spawn another managed worker.
- Saved workflow nesting permits four `workflow()` boundaries; the fifth fails. Cumulative host calls are bounded at `maxAgents * 8 + 100`, shared with nested calls. Arguments, host-call payloads, results, checkpoint responses, and each durable worker report are limited to 1 MiB.
- The runtime module admits 64 simultaneous interpreter calls, including nested calls. These Bun workers execute scripts; they are separate from native agent sessions. Excess calls fail immediately rather than waiting for nested work to free a slot.
- The durable run record is limited to 16 MiB, including embedded settlement order. Payload admission reserves at least 64 KiB for control metadata, with additional space for outstanding step and settlement diagnostics. The reservation reduces usable payload capacity.
- Progress logs retain the newest 200 entries, each truncated to 2,000 characters. Checkpoint prompts are truncated to 10,000 characters. Reports allow at most 100 evidence strings; summary and evidence strings are each limited to 20,000 characters.

## Measured capacity

`bun run verify:workflow-capacity --steps 1000 --timeout 900` passes all eight scenarios on OpenCode 2.0.14 and Bun 1.4.0:

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
| Host-call boundary | 108 accepted; 109 rejected when `maxAgents` is 1 |
| Log retention | Newest 200 of 205 entries retained |
| Cleanup | Zero active sessions; all 1,016 worker identities from the sustained and shared-pool scenarios retained |

The measured source hash is `1414fd9d27ead4a1f955f11168917842aaef043a8eec172b7bd73699aaf3e414`. These timings describe a deterministic provider on one machine, not real-model throughput. RSS is one service sample, not peak memory. The result does not establish capacity at 32 workers, across multiple owners, or over a seven-day run.

Separate native regressions exercise the nesting boundary. Focused tests exercise byte-size limits and simultaneous failure diagnostics. The 35-cycle runtime soak checks CPU termination and native thread cleanup; it does not load-test 64 simultaneous interpreters.

## Native OpenCode limits

The inspected V2 schema defines agent `steps` as a positive integer and exposes no global native-session concurrency ceiling. This is not proof of unlimited capacity. `experimental.subagent_depth` defaults to 1. These native-generation controls are separate from workflow concurrency and total steps. The user's current configuration sets depth to 2 and the `general` agent to 20 steps.

## Practical recommendation

Use at most eight workflow workers per owner, keep the default four for ordinary interactive use, and increase to eight only for an isolated load or known I/O-bound work. Prefer batches of 100–250 concise steps even though 1,000 are admitted. Store large evidence in artifact files and return paths. Keep reports far below 1 MiB so the 16 MiB aggregate journal retains headroom. Do not treat the configured maximum of 32 managed workers as a verified operating target.

The harness writes measured evidence to `.audit/workflow-capacity/evidence.json`. The user's installed plugin retains the default `maxWorkers: 4`; the capacity fixture explicitly configures eight.
