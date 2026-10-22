# Heartbeat reference

Heartbeat monitoring sends queued inspection reminders to the root workflow owner. It never stops workflow work or certifies a result.

## Task tools

Only a root, non-managed owning session can use these tools. They are [Code Mode tools](reference.md#native-and-code-mode-tools): an agent calls `workflows_heartbeat_enroll` as `tools.workflows.heartbeat_enroll` inside `execute`, and likewise for the others.

- `workflows_heartbeat_enroll({ key, runID, policy?, deadlineAt? })` records monitoring without an immediate wake. Neither `maxWakes` nor `deadlineAt` has a default. Omission means unlimited wakes and no monitoring deadline. `wakesRemaining: null` means uncapped, not an unknown count.
- `workflows_heartbeat_inspect({ key? })` reads the owner's monitors without workflow recovery or notification delivery.

- `workflows_heartbeat_update({ key, expectedRevision, change })` tightens policy, suspends, continues, or retires an exact unresolved admission. Policy patches preserve omitted fields. Retirement requires an explicit reason and never refunds a wake.
- `workflows_heartbeat_rebind({ key, expectedRevision, expectedRunID, runID, reason })` binds a fresh run from the same owner and project. An unresolved admission prevents rebind. Previously used runs cannot be reused, including archived bindings.
- `workflows_heartbeat_stop({ key, expectedRevision, reason })` stops that monitor, not the workflow, workers, or shared ticker. Identical mutation retries return the retained original output.

Inspection reads the current raw run but takes no new native observation. When native state is needed, its decision says so explicitly rather than diagnosing a missing run. The last-observation timestamp is unchanged.

The default idle grace is 60 seconds. Progress grace and cooldown are five minutes. Opt-in wake caps and deadlines can be tightened but not removed or extended. Progress, restarts, and replacement runs do not reset usage, sequence, or cooldown.

Hot admission, binding, history, and mutation-receipt projections retain the latest 16 entries. Durable archives and run-identity indexes retain older evidence separately. Projection trimming does not change accounting or retry identity. Archives are not acceptance records. Owner records retain monitor keys and terminal tombstones.

## Checkpoint reviewer

The API remains `checkpoint(prompt, options)`. `options.reviewer` accepts `"human"` or `"coordinator"`; omission and legacy records mean human. Reviewer identity is persisted and validated during replay, including nested workflows. Human or mixed unresolved checkpoints hold monitoring. A coordinator checkpoint permits an inspection reminder, never an automatic response.

## Administrative CLI

The package includes the compiled Node executable `op-threads-heartbeat`. The one-time macOS installer uses a stable host directory where Threads is enabled:

```sh
op-threads-heartbeat install --service-file /absolute/service.json --host-directory /absolute/stable-host
op-threads-heartbeat once --shadow
op-threads-heartbeat status
op-threads-heartbeat uninstall
```

Install and uninstall require an explicit administrative request. Plugin setup does not install anything. Existing watchdogs are not migrated. `--config` selects an absolute runner configuration path. `--node` selects an absolute Node executable during installation. A unique `--label` and isolated `--launchagents-directory` support task-owned lifecycle tests; worktree installation is otherwise rejected.

Installation rejects occupied configuration paths, plist paths, and loaded labels. Failed bootstrap removes only files created by that invocation and does not stop an existing job. If bootstrap succeeds but readback fails, the files remain for explicit uninstall.

The LaunchAgent runs `run` in a separate Node process, which polls every 60 seconds after the previous cycle completes. OpenCode shutdown or plugin unload does not stop that process. During a service outage, it records unavailability and checks the current service registration on the next cycle. Sleep does not cause a catch-up burst. Uninstall removes the launcher and its configuration, but retains logs and plugin monitor records.

A failed observation or apply is recorded for that monitor. The ticker continues with later monitors and pages; it does not retry an uncertain admission after a revision conflict.

The pinned Promise client is `@opencode/client@2.1.2`. This implementation admits only an existing OpenCode `2.1.0`, `2.1.1`, or `2.1.2` local service. Each cycle reads the native registration and performs an authenticated health probe. The registered and live PID and version must match, and the health response must succeed. Discovery requests have a two-second transport timeout; RPC requests have a 25-second timeout and preserve caller cancellation. Both reject redirects.

Native wildcard bind addresses `0.0.0.0` and `[::]` map to loopback for heartbeat requests. OpenCode `2.0.26` wrote unbracketed URLs such as `http://::1:<port>` or `http://:::<port>`, and the runner still brackets only these known local forms in memory. Later versions write bracketed IPv6 URLs. The runner leaves the registration file untouched and rejects remote, ambiguous, credential-bearing, and unsupported URLs.

The runner uses `Service.headers` and a local connect-only probe because the pinned SDK's `Service.discover` cannot accept an in-memory normalized endpoint. It never calls `Service.ensure`, the `opencode api` command, or a service restart.

## Holds and reconciliation

Snapshot RPC reads raw workflow storage. Apply RPC rechecks owner, revision, binding, raw status, and server time before reserving a wake. Busy owners, queued input, permissions, forms, staged reverts, interrupted sessions, paused workflows, and unknown interruption intent hold admission. Native descendants are traversed with a 1,000-session bound; incomplete or unavailable observations hold.

An interrupted run is eligible only when it records `engine-disposed` or `lease-lost` provenance, has an unanswered coordinator checkpoint, and has no worker steps. Human checkpoints still hold. An eligible reminder asks the owner to inspect the run; it does not resume execution or answer the checkpoint. Explicit resume and stop clear the provenance.

Each wake has one durably reserved native message ID. A lost admission response leaves that ID uncertain. Later cycles inspect the exact inbox or message ID once per cooldown until it is found or explicitly retired. An unresolved admission keeps its reservation evidence and its eight latest check results. Absence does not prove that admission never occurred, so the monitor does not repost. Explicit retirement retains evidence and spent usage, including after stop or expiry.

Earlier versions capped these checks with `maxAckRetries`, and an exhausted admission held the monitor for good. Policies no longer accept it. A stored monitor that has the option loses it, and its acknowledgement counter, the next time it is read. Its history gains a `migrate` entry that names the old cap. An unresolved admission then resumes checks at the cooldown. Its enrollment fingerprint is kept, so an identical retry of an enrollment that left `maxAckRetries` at its default of 3 still returns the monitor. Any other retry conflicts as before. A runner process started before this change cannot read the new records; run `uninstall` and `install` to restart it.

The observation-to-admission window is not atomic. New input or a permission request can appear after the final observation. Any raced reminder is queued, not steering, and grants no recovery authority. Stop and apply share a process-global owner lock: a stop waits for an in-flight admission; no later apply can wake a committed stopped monitor. Multiple server processes sharing the same KV store are unsupported because KV exposes no cross-process compare-and-swap.

`inspect.runner` reports the most recently applied ticker observation, not authoritative launchd installation state. Before the first applied monitor tick, configuration is unavailable to the plugin. After uninstall, an old observation becomes stale. CLI `status` reads the actual local launcher and configuration. A monitor's `watching` mode is not proof of ticker health.

## Verification limits

Focused tests cover unlimited monitoring beyond eight simulated days and 40 wakes, bounded hot projections, durable archives, opt-in limits, ambiguity, retirement, restart reconstruction, rebind conservation, and blocker holds. Native verification covers registered policy updates, actual queued input, permissions and forms, cold-host RPC, host eviction, and exact-ID reminders. Isolated LaunchAgent checks cover collisions, cleanup, and the same Node PID surviving an OpenCode outage and reconnecting at the default cadence through a refreshed IPv4 registration.

These checks do not prove atomic admission against concurrent human input, all crash points in native KV, or compatibility with other OpenCode versions. Full integrated engine, terminal, and independent reviewer gates remain separate from this isolated implementation.

Transport tests use real local HTTP listeners for bracketed and unbracketed IPv6, wildcard mapping, authentication, PID/version mismatch, outages, refreshed registration, redirect rejection, and unchanged registration bytes. The native IPv6 trial retains the same external Node PID across an isolated OpenCode restart and verifies both registrations byte-for-byte. The host executable listens on `::1` and remains unchanged. HTTPS has no TLS fixture.

Lifecycle checks exercise explicit task Location invalidation, graceful isolated restart, and actual Threads plugin reload. A separate long-running trial observed automatic Location eviction, but its original elapsed-time assertion failed after machine sleep. A timestamp-based replay and a later reminder trial passed separately. They do not establish a single uninterrupted end-to-end pass.
