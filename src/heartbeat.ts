import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { SessionMessage } from "@opencode/schema/session-message";
import { Session } from "@opencode/schema/session";
import { z } from "zod";
import { heartbeatDecision, heartbeatReminder, heartbeatView } from "./heartbeat-policy";
import { HeartbeatRpc, type HeartbeatSnapshot } from "./heartbeat-rpc";
import { heartbeatBinding, heartbeatFingerprint, heartbeatLocked, heartbeatStore, requireRevision, type OwnerState } from "./heartbeat-store";
import { Enroll, HeartbeatPolicy, HeartbeatRecord, HeartbeatView, Inspect, Inspection, Rebind, Stop, Update, type RunnerHealth } from "./heartbeat-types";
import { workflowStore } from "./workflow-store";

export function heartbeatService(ctx: Pick<Plugin.Context, "storage" | "session">) {
  const store = heartbeatStore(ctx.storage);
  const runs = workflowStore(ctx.storage);
  async function owner(ownerID: string) {
    const session = await ctx.session.get({ sessionID: Session.ID.make(ownerID) });
    if (session.parentID !== undefined || session.metadata?.opThreads !== undefined) throw new Error("Heartbeat requires a root non-managed owner");
    return session;
  }
  async function runFor(ownerID: string, runID: string) {
    const session = await owner(ownerID);
    const run = await runs.get(runID);
    if (run.ownerID !== ownerID || run.projectID !== session.projectID) throw new Error("Heartbeat run owner/project mismatch");
    if (!isAbsolute(run.directory) || !(await stat(run.directory)).isDirectory()) throw new Error("Heartbeat run directory unavailable");
    return run;
  }
  function find(state: OwnerState, key: string) {
    const record = state.monitors.find((item) => item.key === key);
    if (!record) throw new Error("Heartbeat key not enrolled");
    return record;
  }
  function view(record: HeartbeatRecord) { return heartbeatView(record, heartbeatDecision(record, undefined, undefined, Date.now())); }
  function active(record: HeartbeatRecord) {
    if (record.mode === "stopped" || record.mode === "expired" || (record.deadlineAt !== undefined && Date.now() >= record.deadlineAt)) throw new Error("Heartbeat window is terminal");
  }
  async function mutate(ownerID: string, name: string, input: { key: string; expectedRevision: number }, operation: (record: HeartbeatRecord, state: OwnerState) => Promise<void>) {
    await owner(ownerID);
    return heartbeatLocked(ownerID, async () => {
      const state = await store.read(ownerID);
      const fingerprint = heartbeatFingerprint(name, input);
      const receipt = state.receipts.find((item) => item.fingerprint === fingerprint);
      if (receipt) return receipt.output;
      const archivedReceipt = await store.receipt(ownerID, fingerprint);
      if (archivedReceipt) return archivedReceipt;
      const record = find(state, input.key);
      requireRevision(record, input.expectedRevision);
      await operation(record, state);
      record.revision++;
      record.history.push({ at: Date.now(), event: name, detail: JSON.stringify(input) });
      const output = view(record);
      state.receipts.push({ fingerprint, output });
      await store.write(state);
      return output;
    });
  }
  return {
    async enroll(ownerID: string, raw: z.input<typeof Enroll>) {
      const input = Enroll.parse(raw);
      await owner(ownerID);
      return heartbeatLocked(ownerID, async () => {
        const state = await store.read(ownerID);
        const policy = HeartbeatPolicy.parse(input.policy ?? {});
        const fingerprint = heartbeatFingerprint("enroll", { ...input, policy });
        const existing = state.monitors.find((item) => item.key === input.key);
        if (existing) {
          if (existing.enrollmentFingerprint !== fingerprint) throw new Error("Heartbeat enrollment conflicts with retained request");
          return view(existing);
        }
        if (state.monitors.some((item) => item.bindings.some((binding) => binding.runID === input.runID))) throw new Error("Run already enrolled, including retained tombstones");
        const monitorID = `hbm_${heartbeatFingerprint("monitor", { ownerID, key: input.key }).slice(0, 32)}`;
        const used = await store.usedRun(ownerID, input.runID);
        if (used !== undefined && JSON.stringify(used) !== JSON.stringify({ monitorID, enrollmentFingerprint: fingerprint })) throw new Error("Run already enrolled, including archived bindings");
        const run = await runFor(ownerID, input.runID);
        const now = Date.now();
        if (input.deadlineAt !== undefined && input.deadlineAt <= now) throw new Error("Heartbeat deadline must be in the future");
        const binding = heartbeatBinding(run, 0);
        const record = HeartbeatRecord.parse({ key: input.key, ownerID, monitorID, revision: 0,
          enrollmentFingerprint: fingerprint, binding, bindings: [binding], mode: "watching", deadlineAt: input.deadlineAt,
          policy, wakesReserved: 0, sequence: 0, nextWakeAt: now + policy.cooldownMs, lastClockAt: now,
          pendingAdmission: null, admissions: [], history: [{ at: now, event: "enroll", detail: "explicit owner tool request; no immediate wake" }] });
        state.monitors.push(record);
        await store.write(state);
        return view(record);
      });
    },
    async inspect(ownerID: string, input: z.infer<typeof Inspect>) {
      await owner(ownerID);
      const state = await store.read(ownerID);
      const raw = await ctx.storage.get("heartbeat/v1/runner");
      const health = z.object({ configured: z.boolean(), lastTickAt: z.number() }).strict().safeParse(raw);
      const runner: RunnerHealth = health.success
        ? { ...health.data, protocolCompatible: true, status: Date.now() - health.data.lastTickAt < 180_000 ? "healthy" : "stale" }
        : { configured: false, protocolCompatible: false, status: "not-installed", detail: "runner has not applied a tick; configuration is local to CLI" };
      const monitors = await Promise.all((input.key ? [find(state, input.key)] : state.monitors).map(async (record) => {
        const run = await runs.get(record.binding.runID).catch(() => undefined);
        const now = Date.now();
        return heartbeatView(record, heartbeatDecision(record, run, { kind: "unavailable", at: now, reason: "No new native observation; inspect is read-only" }, now));
      }));
      return { monitors, runner };
    },
    async update(ownerID: string, input: z.infer<typeof Update>) {
      return mutate(ownerID, "update", input, async (record) => {
        const change = input.change;
        if (change.type !== "retireAdmission") active(record);
        if (change.type === "policy") {
          const { deadlineAt, ...patch } = change.patch;
          const next = HeartbeatPolicy.parse({ ...record.policy, ...patch });
          if ((record.policy.maxWakes !== undefined && (next.maxWakes === undefined || next.maxWakes > record.policy.maxWakes)) || next.maxAckRetries > record.policy.maxAckRetries || next.cooldownMs < record.policy.cooldownMs || next.idleGraceMs < record.policy.idleGraceMs || next.stalledMs < record.policy.stalledMs || (deadlineAt !== undefined && record.deadlineAt !== undefined && deadlineAt > record.deadlineAt)) throw new Error("Heartbeat policy can only tighten");
          if (record.pendingAdmission) record.pendingAdmission.nextCheckAt += next.cooldownMs - record.policy.cooldownMs;
          record.policy = next;
          if (deadlineAt !== undefined) record.deadlineAt = deadlineAt;
          if (record.lastWakeAt !== undefined) record.nextWakeAt = Math.max(record.nextWakeAt, record.lastWakeAt + next.cooldownMs);
        } else if (change.type === "retireAdmission") {
          if (record.pendingAdmission?.messageID !== change.messageID) throw new Error("Exact pending admission ID required");
          record.pendingAdmission.state = "retired";
          record.pendingAdmission.evidence.push(change.reason);
          record.admissions.push(record.pendingAdmission);
          record.pendingAdmission = null;
        } else record.mode = change.type === "suspend" ? "suspended" : "watching";
      });
    },
    async rebind(ownerID: string, input: z.infer<typeof Rebind>) {
      return mutate(ownerID, "rebind", input, async (record, state) => {
        active(record);
        if (record.pendingAdmission || record.binding.runID !== input.expectedRunID) throw new Error("Pending admission or old binding conflict");
        if (state.monitors.some((item) => item.bindings.some((binding) => binding.runID === input.runID))) throw new Error("Replacement run was already used");
        if (await store.usedRun(ownerID, input.runID) !== undefined) throw new Error("Replacement run was already used, including archive");
        const run = await runFor(ownerID, input.runID);
        if (run.projectID !== record.binding.projectID || run.created <= (await runs.get(record.binding.runID)).created) throw new Error("Replacement must be a fresh recorded run in the same project");
        record.binding = heartbeatBinding(run, record.binding.epoch + 1);
        record.bindings.push(record.binding);
        record.lastObservationAt = Date.now();
      });
    },
    async stop(ownerID: string, input: z.infer<typeof Stop>) {
      return mutate(ownerID, "stop", input, async (record) => { record.mode = "stopped"; });
    },
    async snapshot(input: { afterOwnerID?: string; limit: number }) {
      const page = await store.page(input.afterOwnerID, input.limit);
      const entries: HeartbeatSnapshot[] = [];
      for (const state of page.owners) for (const record of state.monitors) {
        try {
          const run = await runs.get(record.binding.runID);
          if (run.steps.length > 1_000 || run.checkpoints.length > 1_000) throw new Error("Raw projection exceeds observation bound");
          entries.push({ record, run: { id: run.id, ownerID: run.ownerID, projectID: run.projectID, directory: run.directory, fingerprint: run.fingerprint, status: run.status, updated: run.updated, checkpoints: run.checkpoints, ...(run.interruption ? { interruption: run.interruption } : {}), sessionIDs: run.steps.map((step) => step.workerID) } });
        } catch (error) { entries.push({ record, run: null, unavailable: String(error).slice(0, 2_000) }); }
      }
      return { protocol: 1 as const, entries, ...(page.next ? { next: page.next } : {}) };
    },
    async apply(input: z.infer<typeof import("./heartbeat-rpc").Apply>) {
      return heartbeatLocked(input.ownerID, async () => {
        await owner(input.ownerID);
        const state = await store.read(input.ownerID);
        const record = state.monitors.find((item) => item.monitorID === input.monitorID);
        if (!record) throw new Error("Unknown heartbeat monitor");
        requireRevision(record, input.expectedRevision);
        if (record.binding.epoch !== input.bindingEpoch) throw new Error("Binding epoch conflict");
        const now = Date.now();
        const run = await runs.get(record.binding.runID).catch(() => undefined);
        let decision = heartbeatDecision(record, run, input.observation, now);
        if (record.deadlineAt !== undefined && now >= record.deadlineAt && record.mode !== "stopped") record.mode = "expired";
        if (now >= record.lastClockAt) {
          record.lastClockAt = now;
          record.lastObservationAt = input.observation.at;
          const pending = record.pendingAdmission;
          if (pending && pending.checks < record.policy.maxAckRetries && now >= pending.nextCheckAt) {
            pending.checks++;
            pending.nextCheckAt = now + record.policy.cooldownMs;
            const observation = input.observation;
            const ack = observation.kind === "complete" && observation.ownerID === record.ownerID && observation.runID === record.binding.runID && observation.directory === record.binding.directory && observation.at <= now && now - observation.at <= 30_000 ? observation.admission : null;
            pending.evidence.push(ack?.messageID === pending.messageID ? ack.evidence : "exact-ID observation unavailable");
            if (ack?.messageID === pending.messageID && ack.found) {
              pending.state = "acknowledged";
              record.admissions.push(pending);
              record.pendingAdmission = null;
            }
          }
        }
        record.revision++;
        if (decision.kind === "wake") {
          record.sequence++;
          record.wakesReserved++;
          record.lastWakeAt = now;
          record.nextWakeAt = now + record.policy.cooldownMs;
          record.pendingAdmission = { messageID: `msg_${heartbeatFingerprint("reminder", { monitorID: record.monitorID, sequence: record.sequence }).slice(0, 32)}`, sequence: record.sequence, reservedAt: now, checks: 0, nextCheckAt: record.nextWakeAt, state: "uncertain", evidence: ["durable reservation; never automatically repost"] };
          await store.write(state);
          try {
            const admitted = await ctx.session.synthetic({ sessionID: Session.ID.make(record.ownerID), id: SessionMessage.ID.make(record.pendingAdmission.messageID), delivery: "queue", text: heartbeatReminder(record), metadata: { heartbeatMonitorID: record.monitorID, heartbeatSequence: record.sequence } });
            if (admitted.id !== record.pendingAdmission.messageID) throw new Error("Native admission identity mismatch");
            record.pendingAdmission.evidence.push("native queued admission returned exact ID");
            record.pendingAdmission.state = "acknowledged";
            record.admissions.push(record.pendingAdmission);
            record.pendingAdmission = null;
          } catch (error) {
            record.pendingAdmission?.evidence.push(`ambiguous admission: ${String(error).slice(0, 1_500)}`);
            decision = { kind: "hold", reason: "ambiguous admission; no retransmission" };
          }
        }
        await store.write(state);
        await ctx.storage.set("heartbeat/v1/runner", { configured: true, lastTickAt: now });
        return heartbeatView(record, decision);
      });
    },
  };
}

export async function heartbeat(ctx: Plugin.Context) {
  const service = heartbeatService(ctx);
  await ctx.rpc.register(HeartbeatRpc, { snapshot: service.snapshot, apply: service.apply });
  await ctx.tool.transform((editor) => {
    function add<I extends z.ZodType>(name: string, input: I, operation: (ownerID: string, input: z.output<I>) => Promise<HeartbeatView>) {
      editor.add({ name: `heartbeat_${name}`, description: "Explicit owner-requested heartbeat monitoring only. Reminders inspect; they never control workflows or certify acceptance. Limits are lifetime-conserved.", input, output: HeartbeatView, options: { namespace: "workflows", codemode: true }, execute: async (value, tool) => {
        const output = await operation(tool.sessionID, input.parse(value));
        return { content: JSON.stringify(output), output };
      } });
    }
    add("enroll", Enroll, service.enroll);
    add("update", Update, service.update);
    add("rebind", Rebind, service.rebind);
    add("stop", Stop, service.stop);
    editor.add({ name: "heartbeat_inspect", description: "Read only your heartbeat monitors; does not recover workflows or deliver notifications.", input: Inspect, output: Inspection, options: { namespace: "workflows", codemode: true }, execute: async (input, tool) => {
      const output = await service.inspect(tool.sessionID, input);
      return { content: JSON.stringify(output), output };
    } });
  });
}
