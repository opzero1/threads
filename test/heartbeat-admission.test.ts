import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "@opencode/schema/session";
import type { Plugin } from "@opencode/plugin";
import type { Schema } from "effect";
import { heartbeat, heartbeatService } from "../src/heartbeat";
import { z } from "zod";
import { HeartbeatView } from "../src/heartbeat-types";
import { heartbeatStore } from "../src/heartbeat-store";
import { Json } from "../src/workflow-types";
import { run as base } from "./heartbeat-policy.test";

test("registered policy tool patches omit defaults, conserve retry identity, and only tighten explicit limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threads-heartbeat-patch-"));
  try {
    const ownerID = Session.ID.create();
    const values = new Map<string, Schema.Json>();
    const storage: Plugin.Context["storage"] = { get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async () => {}, scan: async () => ({ entries: [] }) };
    type Registered = { name: string; input: z.ZodType; execute: (value: unknown, tool: { sessionID: string }) => Promise<{ output: unknown }> };
    const tools = new Map<string, Registered>();
    // The adapter supplies only registration and owner lookup; production tool parsers and service execute unchanged.
    const ctx = { storage, session: { get: async () => ({ id: ownerID, projectID: "project", metadata: {}, location: { directory } }) }, rpc: { register: async () => {} }, tool: { transform: async (register: (editor: { add: (tool: Registered) => void }) => void) => register({ add: (tool) => { tools.set(tool.name, tool); } }) } } as unknown as Plugin.Context;
    await storage.set("workflows/runs/run", Json.parse({ ...base, ownerID, directory, updated: 1 }));
    await storage.set("workflows/runs/default", Json.parse({ ...base, id: "default", ownerID, directory, updated: 1 }));
    await heartbeat(ctx);
    async function execute(name: string, input: unknown) {
      const tool = tools.get(`heartbeat_${name}`)!;
      return HeartbeatView.parse((await tool.execute(tool.input.parse(input), { sessionID: ownerID })).output);
    }
    const defaults = await execute("enroll", { key: "default", runID: "default" });
    expect(defaults.policy).toEqual({ idleGraceMs: 60_000, stalledMs: 300_000, cooldownMs: 300_000 });
    await expect(execute("enroll", { key: "capped", runID: "run", policy: { maxAckRetries: 3 } })).rejects.toThrow("maxAckRetries");
    expect(defaults.deadlineAt).toBeUndefined(); expect(defaults.wakesRemaining).toBeNull();
    const defaultDeadline = Date.now() + 100_000;
    const deadlineOnly = await execute("update", { key: "default", expectedRevision: defaults.revision, change: { type: "policy", patch: { deadlineAt: defaultDeadline } } });
    expect(deadlineOnly.policy).toEqual(defaults.policy); expect(deadlineOnly.wakesRemaining).toBeNull(); expect(deadlineOnly.deadlineAt).toBe(defaultDeadline);
    let current = await execute("enroll", { key: "key", runID: "run", policy: { idleGraceMs: 1_000, stalledMs: 2_000, cooldownMs: 3_000 } });
    const emptyUnbounded = await execute("update", { key: "key", expectedRevision: current.revision, change: { type: "policy", patch: {} } });
    expect(emptyUnbounded.policy).toEqual(current.policy); expect(emptyUnbounded.deadlineAt).toBeUndefined(); expect(emptyUnbounded.wakesRemaining).toBeNull();
    current = emptyUnbounded;
    const original = current;
    const input = { key: "key", expectedRevision: current.revision, change: { type: "policy", patch: { maxWakes: 5 } } };
    current = await execute("update", input);
    expect(current.policy).toEqual({ ...original.policy, maxWakes: 5 });
    expect(current.deadlineAt).toBeUndefined();
    expect(await execute("update", input)).toEqual(current);
    async function update(patch: Record<string, number>) {
      current = await execute("update", { key: "key", expectedRevision: current.revision, change: { type: "policy", patch } });
      for (const field of ["monitorID", "enrollmentFingerprint", "binding", "bindings", "wakesReserved", "sequence", "pendingAdmission", "admissions", "nextWakeAt"] as const) expect(current[field]).toEqual(original[field]);
      return current;
    }
    const deadlineAt = Date.now() + 100_000;
    await update({ deadlineAt });
    expect(current.policy).toEqual({ ...original.policy, maxWakes: 5 });
    const beforeEmpty = current;
    await update({});
    expect(current.policy).toEqual(beforeEmpty.policy); expect(current.deadlineAt).toBe(deadlineAt);
    await update({ maxWakes: 4, deadlineAt: deadlineAt - 1_000, idleGraceMs: 2_000, stalledMs: 3_000, cooldownMs: 4_000 });
    expect(current.policy).toEqual({ maxWakes: 4, idleGraceMs: 2_000, stalledMs: 3_000, cooldownMs: 4_000 });
    for (const patch of [{ maxWakes: 5 }, { deadlineAt }, { idleGraceMs: 1_000 }, { stalledMs: 2_000 }, { cooldownMs: 3_000 }]) {
      const before = JSON.stringify([...values]);
      await expect(execute("update", { key: "key", expectedRevision: current.revision, change: { type: "policy", patch } })).rejects.toThrow("only tighten");
      expect(JSON.stringify([...values])).toBe(before);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reservation ambiguity never reposts; cooldown-spaced reconciliation and rebind conserve budgets across service reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threads-heartbeat-unit-"));
  try {
    const ownerID = Session.ID.create();
    const values = new Map<string, Schema.Json>();
    const admissions: string[] = [];
    const storage: Plugin.Context["storage"] = { get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async () => {}, scan: async () => ({ entries: [...values].filter(([key]) => key.startsWith("heartbeat/v1/owners/")).map(([key, value]) => ({ key, value })) }) };
    // Only the installed domain's two used methods are supplied in this isolated boundary fixture.
    const session = { get: async () => ({ id: ownerID, projectID: "project", metadata: {}, location: { directory } }), synthetic: async (input: { id?: string }) => { admissions.push(input.id ?? "missing"); throw new Error("lost response"); } } as unknown as Plugin.Context["session"];
    const ctx = { storage, session };
    const rawRun = { ...base, ownerID, directory, updated: 1 };
    await storage.set("workflows/runs/run", Json.parse(rawRun));
    let api = heartbeatService(ctx);
    const enrolled = await api.enroll(ownerID, { key: "key", runID: "run", deadlineAt: Date.now() + 1_000_000, policy: { maxWakes: 2, cooldownMs: 1_000, idleGraceMs: 1_000, stalledMs: 1_000 } });
    const initialSnapshot = await api.snapshot({ limit: 100 });
    expect(Object.hasOwn(initialSnapshot.entries[0].run!, "interruption")).toBe(false);
    expect(Json.safeParse(initialSnapshot).success).toBe(true);
    expect((await api.enroll(ownerID, { key: "key", runID: "run", deadlineAt: enrolled.deadlineAt, policy: enrolled.policy })).monitorID).toBe(enrolled.monitorID);
    await expect(api.enroll(ownerID, { key: "other", runID: "run", deadlineAt: enrolled.deadlineAt })).rejects.toThrow("already enrolled");
    await Bun.sleep(1_010);
    const observation = () => ({ kind: "complete" as const, at: Date.now(), ownerID, runID: "run", directory, sessions: [{ id: ownerID, projectID: "project", busy: false, queued: false, permission: false, form: false, revert: false, interrupted: false, idleAt: 1 }], admission: null });
    const apply = (revision: number, obs = observation()) => api.apply({ ownerID, monitorID: enrolled.monitorID, expectedRevision: revision, bindingEpoch: 0, observation: obs });
    const reserved = await apply(0);
    expect(reserved.wakesReserved).toBe(1); expect(reserved.pendingAdmission).not.toBeNull(); expect(admissions).toHaveLength(1);
    api = heartbeatService(ctx);
    const held = await apply(reserved.revision);
    expect(held.pendingAdmission?.messageID).toBe(reserved.pendingAdmission?.messageID); expect(admissions).toHaveLength(1);
    await Bun.sleep(1_010);
    const checked = await apply(held.revision);
    expect(checked.pendingAdmission?.nextCheckAt).toBeGreaterThan(held.pendingAdmission!.nextCheckAt);
    const cooling = await apply(checked.revision);
    expect(cooling.pendingAdmission).toEqual(checked.pendingAdmission!); expect(admissions).toHaveLength(1);
    await storage.set("workflows/runs/replacement", Json.parse({ ...rawRun, id: "replacement", created: 2, fingerprint: "new" }));
    await expect(api.rebind(ownerID, { key: "key", expectedRevision: cooling.revision, expectedRunID: "run", runID: "replacement", reason: "rename" })).rejects.toThrow("Pending admission");
    const retired = await api.update(ownerID, { key: "key", expectedRevision: cooling.revision, change: { type: "retireAdmission", messageID: reserved.pendingAdmission!.messageID, reason: "inspected cancellation" } });
    const rebound = await api.rebind(ownerID, { key: "key", expectedRevision: retired.revision, expectedRunID: "run", runID: "replacement", reason: "rename" });
    for (const field of ["deadlineAt", "wakesReserved", "sequence", "lastWakeAt", "nextWakeAt"] as const) expect(rebound[field]).toBe(reserved[field]);
    const stopInput = { key: "key", expectedRevision: rebound.revision, reason: "done, not acceptance" };
    const stopped = await api.stop(ownerID, stopInput);
    expect(await heartbeatService(ctx).stop(ownerID, stopInput)).toEqual(stopped);
    await expect(api.update(ownerID, { key: "key", expectedRevision: stopped.revision, change: { type: "continue", reason: "refill" } })).rejects.toThrow("terminal");
    const before = JSON.stringify([...values]);
    await api.snapshot({ limit: 100 }); await api.inspect(ownerID, {});
    expect(JSON.stringify([...values])).toBe(before);
    expect((await heartbeatStore(storage).read(ownerID)).monitors[0].admissions[0].state).toBe("retired");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stored acknowledgement cap is dropped in history; checks continue until a late exact-ID acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threads-heartbeat-late-"));
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const ownerID = Session.ID.create();
    const values = new Map<string, Schema.Json>();
    const admitted: string[] = [];
    const storage: Plugin.Context["storage"] = { get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async () => {}, scan: async () => ({ entries: [] }) };
    const session = { get: async () => ({ id: ownerID, projectID: "project", metadata: {}, location: { directory } }), synthetic: async (input: { id: string }) => { admitted.push(input.id); throw new Error("lost response"); } } as unknown as Plugin.Context["session"];
    const ctx = { storage, session };
    await storage.set("workflows/runs/run", Json.parse({ ...base, ownerID, directory, updated: 1 }));
    const policy = { cooldownMs: 1_000, idleGraceMs: 1_000, stalledMs: 1_000 };
    const enrolled = await heartbeatService(ctx).enroll(ownerID, { key: "late", runID: "run", policy });
    const apply = (current: HeartbeatView, admission: { messageID: string; found: boolean; evidence: string } | null) => heartbeatService(ctx).apply({ ownerID, monitorID: current.monitorID, expectedRevision: current.revision, bindingEpoch: 0,
      observation: { kind: "complete", at: now, ownerID, runID: "run", directory, sessions: [{ id: ownerID, projectID: "project", busy: false, queued: false, permission: false, form: false, revert: false, interrupted: false, idleAt: 1 }], admission } });
    now += 1_000;
    let current = await apply(enrolled, null);
    const messageID = current.pendingAdmission!.messageID;
    const key = `heartbeat/v1/owners/${ownerID}`;
    const legacy = structuredClone(values.get(key)) as { monitors: { policy: object; pendingAdmission: object }[] };
    legacy.monitors[0].policy = { ...legacy.monitors[0].policy, maxAckRetries: 3 };
    legacy.monitors[0].pendingAdmission = { ...legacy.monitors[0].pendingAdmission, checks: 3 };
    await storage.set(key, Json.parse(legacy));
    for (let check = 0; check < 12; check++) {
      now += 1_000;
      current = await apply(current, { messageID, found: false, evidence: "exact ID not observable; absence does not prove non-admission or authorize repost" });
      expect(current.decision.reason).toBe("unresolved admission; read-only reconciliation only");
      expect(current.pendingAdmission?.nextCheckAt).toBe(now + 1_000);
    }
    expect(current.policy).toEqual(policy);
    expect(current.history.filter((item) => item.event === "migrate").map((item) => item.detail)).toEqual(["removed maxAckRetries 3; unresolved admissions are checked every cooldown until found or retired"]);
    expect(current.pendingAdmission!.evidence).toHaveLength(10);
    expect(current.pendingAdmission!.evidence.slice(0, 2)).toEqual(["durable reservation; never automatically repost", "ambiguous admission: Error: lost response"]);
    now += 1_000;
    const acknowledged = await apply(current, { messageID, found: true, evidence: "exact synthetic message ID and monitor metadata" });
    expect(acknowledged.pendingAdmission).toBeNull();
    expect(acknowledged.admissions.at(-1)).toMatchObject({ messageID, state: "acknowledged" });
    expect(acknowledged.admissions.at(-1)!.evidence.at(-1)).toBe("exact synthetic message ID and monitor metadata");
    expect(admitted).toEqual([messageID]);
  } finally { clock.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

test("default enrollment stays watching beyond seven days and forty wakes; hot receipts are bounded and durable archives survive rebind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threads-heartbeat-uncapped-"));
  const realNow = Date.now();
  let now = realNow;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const ownerID = Session.ID.create();
    const values = new Map<string, Schema.Json>();
    const admitted: string[] = [];
    const storage: Plugin.Context["storage"] = { get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async () => {}, scan: async () => ({ entries: [...values].filter(([key]) => key.startsWith("heartbeat/v1/owners/")).map(([key, value]) => ({ key, value })) }) };
    const session = { get: async () => ({ id: ownerID, projectID: "project", metadata: {}, location: { directory } }), synthetic: async (input: { id: string; delivery: string }) => { expect(input.delivery).toBe("queue"); admitted.push(input.id); return { id: input.id }; } } as unknown as Plugin.Context["session"];
    const ctx = { storage, session };
    await storage.set("workflows/runs/run", Json.parse({ ...base, ownerID, directory, updated: 1 }));
    const api = heartbeatService(ctx);
    let current = await api.enroll(ownerID, { key: "unbounded", runID: "run" });
    expect(current.deadlineAt).toBeUndefined(); expect(current.policy.maxWakes).toBeUndefined(); expect(current.wakesRemaining).toBeNull();
    now += 8 * 86_400_000;
    for (let index = 0; index < 40; index++) {
      current = await heartbeatService(ctx).apply({ ownerID, monitorID: current.monitorID, expectedRevision: current.revision, bindingEpoch: 0,
        observation: { kind: "complete", at: now, ownerID, runID: "run", directory, sessions: [{ id: ownerID, projectID: "project", busy: false, queued: false, permission: false, form: false, revert: false, interrupted: false, idleAt: 1 }], admission: null } });
      expect(current.mode).toBe("watching");
      now += current.policy.cooldownMs;
    }
    expect(current.wakesReserved).toBe(40); expect(current.sequence).toBe(40); expect(new Set(admitted).size).toBe(40);
    const hot = (await heartbeatStore(storage).read(ownerID)).monitors[0];
    expect(hot.admissions.length).toBe(16);
    expect([...values.keys()].filter((key) => key.includes("/admissions/")).length).toBe(40);
    await storage.set("workflows/runs/fresh", Json.parse({ ...base, id: "fresh", ownerID, directory, created: 2, fingerprint: "fresh" }));
    const rebound = await heartbeatService(ctx).rebind(ownerID, { key: "unbounded", expectedRevision: current.revision, expectedRunID: "run", runID: "fresh", reason: "replacement" });
    for (const field of ["deadlineAt", "wakesReserved", "sequence", "lastWakeAt", "nextWakeAt"] as const) expect(rebound[field]).toBe(current[field]);
    let latest = rebound;
    for (let index = 0; index < 20; index++) {
      const id = `replacement-${index}`;
      await storage.set(`workflows/runs/${id}`, Json.parse({ ...base, id, ownerID, directory, created: 3 + index, fingerprint: id }));
      latest = await heartbeatService(ctx).rebind(ownerID, { key: "unbounded", expectedRevision: latest.revision, expectedRunID: latest.binding.runID, runID: id, reason: "replacement" });
    }
    expect((await heartbeatStore(storage).read(ownerID)).monitors[0].bindings.length).toBe(16);
    expect((await heartbeatStore(storage).read(ownerID)).receipts.length).toBe(16);
    const beforeInspect = JSON.stringify([...values]);
    const inspection = await api.inspect(ownerID, { key: "unbounded" });
    expect(inspection.monitors[0].decision.reason).toBe("No new native observation; inspect is read-only");
    expect(inspection.monitors[0].lastObservationAt).toBe(latest.lastObservationAt);
    expect(JSON.stringify([...values])).toBe(beforeInspect);
    expect(await api.rebind(ownerID, { key: "unbounded", expectedRevision: current.revision, expectedRunID: "run", runID: "fresh", reason: "replacement" })).toEqual(rebound);
    await expect(api.rebind(ownerID, { key: "unbounded", expectedRevision: latest.revision, expectedRunID: latest.binding.runID, runID: "run", reason: "reuse" })).rejects.toThrow("already used");
    const capped = await api.update(ownerID, { key: "unbounded", expectedRevision: latest.revision, change: { type: "policy", patch: { maxWakes: 40, deadlineAt: now + 1_000 } } });
    expect(capped.wakesRemaining).toBe(0);
    const held = await api.apply({ ownerID, monitorID: capped.monitorID, expectedRevision: capped.revision, bindingEpoch: capped.binding.epoch, observation: { kind: "unavailable", at: now, reason: "test" } });
    expect(held.decision.reason).toBe("lifetime wake cap");
    now += 1_000;
    const expired = await api.apply({ ownerID, monitorID: held.monitorID, expectedRevision: held.revision, bindingEpoch: held.binding.epoch, observation: { kind: "unavailable", at: now, reason: "test" } });
    expect(expired.mode).toBe("expired"); expect(expired.wakesReserved).toBe(40); expect(expired.sequence).toBe(40);
  } finally { clock.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
