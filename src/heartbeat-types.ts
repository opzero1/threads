import { z } from "zod";

const id = z.string().min(1).max(200);
const clock = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policyFields = {
  idleGraceMs: clock.min(1_000),
  stalledMs: clock.min(1_000),
  cooldownMs: clock.min(1_000),
  maxWakes: clock.optional(),
};
export const HeartbeatPolicy = z.object({
  ...policyFields,
  idleGraceMs: policyFields.idleGraceMs.default(60_000),
  stalledMs: policyFields.stalledMs.default(300_000),
  cooldownMs: policyFields.cooldownMs.default(300_000),
}).strict();
const PolicyPatch = z.object(policyFields).partial().extend({ deadlineAt: clock.optional() }).strict();
export const HeartbeatBinding = z.object({ epoch: clock, runID: id, projectID: id, directory: z.string().min(1), runFingerprint: id }).strict();
export const Admission = z.object({
  messageID: id, sequence: clock, reservedAt: clock, nextCheckAt: clock,
  state: z.enum(["uncertain", "acknowledged", "retired"]), evidence: z.array(z.string().max(2_000)),
}).strict();
export const HeartbeatRecord = z.object({
  key: id, monitorID: id, ownerID: id, revision: clock, enrollmentFingerprint: id,
  binding: HeartbeatBinding, bindings: z.array(HeartbeatBinding), mode: z.enum(["watching", "suspended", "stopped", "expired"]),
  deadlineAt: clock.optional(), policy: HeartbeatPolicy, wakesReserved: clock, sequence: clock,
  lastWakeAt: clock.optional(), nextWakeAt: clock, lastObservationAt: clock.optional(), lastClockAt: clock,
  pendingAdmission: Admission.nullable(), admissions: z.array(Admission),
  history: z.array(z.object({ at: clock, event: z.string(), detail: z.string() }).strict()),
}).strict();
export type HeartbeatRecord = z.infer<typeof HeartbeatRecord>;
export const Decision = z.object({ kind: z.enum(["hold", "wake", "expired", "stopped"]), reason: z.string() }).strict();
export const HeartbeatView = HeartbeatRecord.extend({ wakesRemaining: clock.nullable(), decision: Decision });
export type HeartbeatView = z.infer<typeof HeartbeatView>;
export const HeartbeatObservation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), at: clock, reason: z.string().max(2_000) }).strict(),
  z.object({
    kind: z.literal("complete"), at: clock, ownerID: id, runID: id, directory: z.string(),
    sessions: z.array(z.object({
      id, parentID: id.optional(), projectID: id, busy: z.boolean(), queued: z.boolean(), permission: z.boolean(), form: z.boolean(),
      revert: z.boolean(), interrupted: z.boolean(), idleAt: clock,
    }).strict()).max(1_000),
    admission: z.object({ messageID: id, found: z.boolean(), evidence: z.string().max(2_000) }).strict().nullable(),
  }).strict(),
]);
export type HeartbeatObservation = z.infer<typeof HeartbeatObservation>;
export const Enroll = z.object({ key: id, runID: id, deadlineAt: clock.optional(), policy: HeartbeatPolicy.partial().optional() }).strict();
export const Update = z.object({ key: id, expectedRevision: clock, change: z.discriminatedUnion("type", [
  z.object({ type: z.literal("policy"), patch: PolicyPatch }).strict(),
  z.object({ type: z.enum(["suspend", "continue"]), reason: z.string().min(1).max(2_000) }).strict(),
  z.object({ type: z.literal("retireAdmission"), messageID: id, reason: z.string().min(1).max(2_000) }).strict(),
]) }).strict();
export const Rebind = z.object({ key: id, expectedRevision: clock, expectedRunID: id, runID: id, reason: z.string().min(1).max(2_000) }).strict();
export const Stop = z.object({ key: id, expectedRevision: clock, reason: z.string().min(1).max(2_000) }).strict();
export const Inspect = z.object({ key: id.optional() }).strict();
export const RunnerHealth = z.object({ configured: z.boolean(), protocolCompatible: z.boolean(), lastTickAt: clock.optional(), status: z.enum(["healthy", "stale", "unavailable", "not-installed"]), detail: z.string().optional() }).strict();
export type RunnerHealth = z.infer<typeof RunnerHealth>;
export const Inspection = z.object({ monitors: z.array(HeartbeatView), runner: RunnerHealth }).strict();
