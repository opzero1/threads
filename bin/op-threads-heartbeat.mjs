#!/usr/bin/env node

// src/heartbeat-runner.ts
import { Service as Service2 } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { lstat, mkdir, open, readFile as readFile2, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z as z6 } from "zod";

// src/heartbeat-rpc.ts
import { Rpc as Rpc2 } from "@opencode/plugin/rpc";
import { z as z4 } from "zod";

// src/heartbeat-types.ts
import { z } from "zod";
var id = z.string().min(1).max(200);
var clock = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var policyFields = {
  idleGraceMs: clock.min(1000),
  stalledMs: clock.min(1000),
  cooldownMs: clock.min(1000),
  maxWakes: clock.optional()
};
var HeartbeatPolicy = z.object({
  ...policyFields,
  idleGraceMs: policyFields.idleGraceMs.default(60000),
  stalledMs: policyFields.stalledMs.default(300000),
  cooldownMs: policyFields.cooldownMs.default(300000)
}).strict();
var PolicyPatch = z.object(policyFields).partial().extend({ deadlineAt: clock.optional() }).strict();
var HeartbeatBinding = z.object({ epoch: clock, runID: id, projectID: id, directory: z.string().min(1), runFingerprint: id }).strict();
var Admission = z.object({
  messageID: id,
  sequence: clock,
  reservedAt: clock,
  nextCheckAt: clock,
  state: z.enum(["uncertain", "acknowledged", "retired"]),
  evidence: z.array(z.string().max(2000))
}).strict();
var HeartbeatRecord = z.object({
  key: id,
  monitorID: id,
  ownerID: id,
  revision: clock,
  enrollmentFingerprint: id,
  binding: HeartbeatBinding,
  bindings: z.array(HeartbeatBinding),
  mode: z.enum(["watching", "suspended", "stopped", "expired"]),
  deadlineAt: clock.optional(),
  policy: HeartbeatPolicy,
  wakesReserved: clock,
  sequence: clock,
  lastWakeAt: clock.optional(),
  nextWakeAt: clock,
  lastObservationAt: clock.optional(),
  lastClockAt: clock,
  pendingAdmission: Admission.nullable(),
  admissions: z.array(Admission),
  history: z.array(z.object({ at: clock, event: z.string(), detail: z.string() }).strict())
}).strict();
var Decision = z.object({ kind: z.enum(["hold", "wake", "expired", "stopped"]), reason: z.string() }).strict();
var HeartbeatView = HeartbeatRecord.extend({ wakesRemaining: clock.nullable(), decision: Decision });
var HeartbeatObservation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), at: clock, reason: z.string().max(2000) }).strict(),
  z.object({
    kind: z.literal("complete"),
    at: clock,
    ownerID: id,
    runID: id,
    directory: z.string(),
    sessions: z.array(z.object({
      id,
      parentID: id.optional(),
      projectID: id,
      busy: z.boolean(),
      queued: z.boolean(),
      permission: z.boolean(),
      form: z.boolean(),
      revert: z.boolean(),
      interrupted: z.boolean(),
      idleAt: clock
    }).strict()).max(1000),
    admission: z.object({ messageID: id, found: z.boolean(), evidence: z.string().max(2000) }).strict().nullable()
  }).strict()
]);
var Enroll = z.object({ key: id, runID: id, deadlineAt: clock.optional(), policy: HeartbeatPolicy.partial().optional() }).strict();
var Update = z.object({ key: id, expectedRevision: clock, change: z.discriminatedUnion("type", [
  z.object({ type: z.literal("policy"), patch: PolicyPatch }).strict(),
  z.object({ type: z.enum(["suspend", "continue"]), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("retireAdmission"), messageID: id, reason: z.string().min(1).max(2000) }).strict()
]) }).strict();
var Rebind = z.object({ key: id, expectedRevision: clock, expectedRunID: id, runID: id, reason: z.string().min(1).max(2000) }).strict();
var Stop = z.object({ key: id, expectedRevision: clock, reason: z.string().min(1).max(2000) }).strict();
var Inspect = z.object({ key: id.optional() }).strict();
var RunnerHealth = z.object({ configured: z.boolean(), protocolCompatible: z.boolean(), lastTickAt: clock.optional(), status: z.enum(["healthy", "stale", "unavailable", "not-installed"]), detail: z.string().optional() }).strict();
var Inspection = z.object({ monitors: z.array(HeartbeatView), runner: RunnerHealth }).strict();

// src/workflow-types.ts
import { z as z3 } from "zod";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
import { z as z2 } from "zod";
var Report = z2.object({
  verdict: z2.enum(["PASS", "PASS WITH NOTES", "FAIL", "INCONCLUSIVE"]),
  summary: z2.string().min(1),
  evidence: z2.array(z2.string())
}).strict();
var WorkerView = z2.object({
  workerID: z2.string(),
  coordinatorID: z2.string(),
  key: z2.string(),
  title: z2.string(),
  directory: z2.string(),
  agent: z2.string().nullable(),
  model: z2.object({
    providerID: z2.string(),
    id: z2.string(),
    variant: z2.string().optional()
  }).nullable(),
  outcome: z2.enum(["succeeded", "failed", "interrupted"]).nullable(),
  report: Report.nullable(),
  hidden: z2.boolean()
});
var ThreadsRpc = Rpc.define({
  id: "threads",
  methods: {
    snapshot: {
      input: z2.object({ coordinatorIDs: z2.array(z2.string()).max(100) }).strict(),
      output: z2.object({ workers: z2.array(WorkerView) }),
      errors: {}
    },
    restore: {
      input: z2.object({ coordinatorIDs: z2.array(z2.string()).max(100) }).strict(),
      output: z2.object({ workers: z2.array(WorkerView) }),
      errors: {}
    }
  },
  events: {}
});

// src/workflow-types.ts
var WORKFLOW_CONTROL_HEADROOM = 64 * 1024;
var Json = z3.json();
var WorkflowModel = z3.object({
  providerID: z3.string(),
  id: z3.string(),
  variant: z3.string().optional()
});
var WorkflowLimits = z3.object({
  concurrency: z3.number().int().min(1).max(8).default(3),
  maxAgents: z3.number().int().min(1).max(1000).nullable().default(4),
  agentTimeoutMs: z3.number().int().min(1000).max(604800000).nullable().default(1800000),
  timeoutMs: z3.number().int().min(1000).max(604800000).nullable().default(86400000),
  tokenBudget: z3.number().int().positive().nullable().optional()
});
var WorkflowStart = WorkflowLimits.extend({
  maxAgents: WorkflowLimits.shape.maxAgents.default(null),
  agentTimeoutMs: WorkflowLimits.shape.agentTimeoutMs.default(null),
  timeoutMs: WorkflowLimits.shape.timeoutMs.default(null),
  key: z3.string().min(1).max(120),
  script: z3.string().min(1).max(200000).optional(),
  name: z3.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
  args: Json.default(null)
}).strict().refine((value) => Boolean(value.script) !== Boolean(value.name), {
  message: "Supply exactly one of script or saved workflow name"
});
var MAX_GRANTED_PATHS = 16;
var GrantedPaths = z3.array(z3.string().min(1).max(4096)).max(MAX_GRANTED_PATHS);
var WorkflowAgentInput = z3.object({
  key: z3.string().min(1).max(120),
  prompt: z3.string().min(1).max(1e5),
  agent: z3.string().min(1),
  label: z3.string().min(1).max(160).optional(),
  phase: z3.string().min(1).max(160).optional(),
  schema: z3.record(z3.string(), Json).optional(),
  access: z3.enum(["read", "write"]).default("read"),
  isolation: z3.enum(["shared", "worktree"]).default("shared"),
  directory: z3.string().min(1).optional(),
  paths: GrantedPaths.optional(),
  timeoutMs: z3.number().int().min(1000).max(604800000).optional()
}).strict();
var WorkflowResult = Report.extend({ result: Json }).strict();
var WorkflowUsage = z3.object({
  tokens: z3.number().nonnegative(),
  cost: z3.number().nonnegative(),
  measured: z3.boolean()
});
var StepBase = z3.object({
  key: z3.string(),
  fingerprint: z3.string(),
  index: z3.number().int().nonnegative(),
  input: WorkflowAgentInput,
  workerID: z3.string(),
  spawnKey: z3.string(),
  created: z3.number(),
  phase: z3.string(),
  directory: z3.string(),
  model: WorkflowModel,
  profileFingerprint: z3.string()
});
var WorkflowStep = z3.discriminatedUnion("status", [
  StepBase.extend({ status: z3.literal("prepared") }),
  StepBase.extend({ status: z3.literal("running"), usage: WorkflowUsage.optional() }),
  StepBase.extend({
    status: z3.literal("completed"),
    completed: z3.number(),
    report: WorkflowResult,
    usage: WorkflowUsage
  }),
  StepBase.extend({
    status: z3.literal("failed"),
    error: z3.string(),
    retryable: z3.boolean(),
    usage: WorkflowUsage.optional()
  })
]);
var WorkflowCheckpoint = z3.object({
  key: z3.string(),
  prompt: z3.string(),
  reviewer: z3.enum(["human", "coordinator"]).optional(),
  response: Json.optional()
});
var WorkflowSettlement = z3.discriminatedUnion("kind", [
  z3.object({ kind: z3.literal("agent"), key: z3.string(), outcome: z3.enum(["success", "failure"]), error: z3.string().optional() }),
  z3.object({ kind: z3.literal("checkpoint"), key: z3.string(), response: Json })
]);
var WorktreeKeptReason = z3.enum(["changes", "commits", "nested", "in-use", "unregistered", "error"]);
var WorkflowWorktreeOutcome = z3.object({
  key: z3.string(),
  directory: z3.string(),
  outcome: z3.enum(["removed", "kept", "missing"]),
  reason: WorktreeKeptReason.optional(),
  message: z3.string().optional(),
  at: z3.number()
});
var WorkflowRun = z3.object({
  version: z3.literal(1),
  helperPolicy: z3.enum(["legacy-bounded", "optional-counts"]).default("legacy-bounded"),
  id: z3.string(),
  key: z3.string(),
  ownerID: z3.string(),
  callerAgent: z3.string(),
  model: WorkflowModel,
  projectID: z3.string(),
  directory: z3.string(),
  name: z3.string(),
  description: z3.string(),
  script: z3.string(),
  args: Json,
  fingerprint: z3.string(),
  limits: WorkflowLimits,
  status: z3.enum(["running", "pausing", "paused", "stopping", "stopped", "waiting", "interrupted", "failed", "completed"]),
  interruption: z3.object({
    kind: z3.enum(["engine-disposed", "lease-lost"]),
    priorStatus: z3.enum(["running", "waiting"]),
    at: z3.number().finite().nonnegative()
  }).optional(),
  created: z3.number(),
  updated: z3.number(),
  finished: z3.number().optional(),
  phase: z3.string(),
  steps: z3.array(WorkflowStep),
  logs: z3.array(z3.object({ time: z3.number(), text: z3.string() })),
  checkpoints: z3.array(WorkflowCheckpoint),
  settlements: z3.array(WorkflowSettlement).optional(),
  attention: z3.object({
    checkpoints: z3.array(z3.string()),
    interruption: z3.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deliveredInterruption: z3.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }).optional(),
  result: Json.optional(),
  error: z3.string().optional(),
  deliveryID: z3.string(),
  delivered: z3.boolean(),
  worktreeCleanup: z3.object({
    complete: z3.boolean(),
    worktrees: z3.array(WorkflowWorktreeOutcome)
  }).optional()
});
var WorkflowPrune = z3.object({
  apply: z3.boolean().default(false),
  olderThanDays: z3.number().min(0).max(3650).optional()
}).strict();
var WorkflowPruneEntry = z3.object({
  runID: z3.string(),
  runStatus: WorkflowRun.shape.status,
  key: z3.string(),
  directory: z3.string(),
  outcome: z3.enum(["removed", "would-remove", "kept"]),
  reason: z3.enum([...WorktreeKeptReason.options, "unfinished"]).optional(),
  message: z3.string().optional()
});
var WorkflowPruneResult = z3.object({
  applied: z3.boolean(),
  worktrees: z3.array(WorkflowPruneEntry),
  counts: z3.object({ removed: z3.number(), wouldRemove: z3.number(), kept: z3.number() })
});
var WorkflowSummary = WorkflowRun.omit({ script: true, args: true, result: true, steps: true, logs: true, checkpoints: true, settlements: true, attention: true, fingerprint: true, callerAgent: true, deliveryID: true, delivered: true, worktreeCleanup: true }).extend({
  counts: z3.object({ completed: z3.number(), running: z3.number(), failed: z3.number(), total: z3.number() }),
  usage: WorkflowUsage
});

// src/heartbeat-rpc.ts
var RawRun = WorkflowRun.pick({ id: true, ownerID: true, projectID: true, directory: true, fingerprint: true, status: true, updated: true, checkpoints: true, interruption: true }).extend({ sessionIDs: z4.array(z4.string()).max(1000) }).strict();
var HeartbeatSnapshot = z4.object({ record: HeartbeatRecord, run: RawRun.nullable(), unavailable: z4.string().optional() }).strict();
var SnapshotInput = z4.object({ afterOwnerID: z4.string().optional(), limit: z4.number().int().min(1).max(100).default(100) }).strict();
var SnapshotOutput = z4.object({ protocol: z4.literal(1), entries: z4.array(HeartbeatSnapshot), next: z4.string().optional() }).strict();
var Apply = z4.object({ ownerID: z4.string(), monitorID: z4.string(), expectedRevision: z4.number().int(), bindingEpoch: z4.number().int(), observation: HeartbeatObservation }).strict();
var HeartbeatRpc = Rpc2.define({ id: "workflows-heartbeat", methods: {
  snapshot: { input: SnapshotInput, output: SnapshotOutput, errors: {} },
  apply: { input: Apply, output: HeartbeatView, errors: {} }
}, events: {} });

// src/heartbeat-observe.ts
async function heartbeatObserve(client, snapshot) {
  const startedAt = Date.now();
  try {
    if (!snapshot.run)
      throw new Error(snapshot.unavailable ?? "raw run unavailable");
    const { record, run } = snapshot;
    const active = await client.session.active();
    const ids = new Set([record.ownerID, ...run.sessionIDs]);
    const sessions = [];
    const queue = [...ids];
    for (let index = 0;index < queue.length; index++) {
      if (queue.length > 1000)
        throw new Error("native descendant traversal exceeds bound");
      const id = queue[index];
      const session = await client.session.get({ sessionID: id });
      if (id === record.ownerID && (session.parentID !== undefined || session.metadata?.opThreads !== undefined || session.projectID !== record.binding.projectID))
        throw new Error("owner scope changed");
      const [inbox, permissions, forms] = await Promise.all([
        client.session.inbox.list({ sessionID: id }),
        client.permission.list({ sessionID: id }),
        client.session.form.list({ sessionID: id })
      ]);
      sessions.push({
        id,
        parentID: session.parentID,
        projectID: session.projectID,
        busy: active[id] !== undefined,
        queued: inbox.length > 0,
        permission: permissions.length > 0,
        form: forms.length > 0,
        revert: session.revert !== undefined,
        interrupted: session.outcome === "interrupted",
        idleAt: session.time.idle ?? Date.now()
      });
      let cursor;
      do {
        const children = await client.session.list({ parentID: id, limit: 100, cursor });
        for (const child of children.data) {
          if (!ids.has(child.id)) {
            ids.add(child.id);
            queue.push(child.id);
          }
        }
        cursor = children.cursor.next ?? undefined;
      } while (cursor);
    }
    let admission = null;
    const pending = record.pendingAdmission;
    if (pending && Date.now() >= pending.nextCheckAt) {
      const inbox = await client.session.inbox.list({ sessionID: record.ownerID });
      const item = inbox.find((entry) => entry.id === pending.messageID);
      if (item) {
        if (item.type !== "synthetic" || item.payload.metadata?.heartbeatMonitorID !== record.monitorID)
          throw new Error("exact inbox admission identity mismatch");
        admission = { messageID: pending.messageID, found: true, evidence: "exact synthetic inbox ID and monitor metadata" };
      } else {
        try {
          const message = await client.session.message.get({ sessionID: record.ownerID, messageID: pending.messageID });
          if (message.type !== "synthetic" || message.metadata?.heartbeatMonitorID !== record.monitorID)
            throw new Error("exact message admission identity mismatch");
          admission = { messageID: pending.messageID, found: true, evidence: "exact synthetic message ID and monitor metadata" };
        } catch {
          admission = { messageID: pending.messageID, found: false, evidence: "exact ID not observable; absence does not prove non-admission or authorize repost" };
        }
      }
    }
    return { kind: "complete", at: startedAt, ownerID: record.ownerID, runID: run.id, directory: run.directory, sessions, admission };
  } catch (error) {
    return { kind: "unavailable", at: Date.now(), reason: String(error).slice(0, 2000) };
  }
}

// src/heartbeat-policy.ts
function heartbeatProjectionDecision(record, run, observation, now) {
  const hold = (reason) => ({ kind: "hold", reason });
  if (record.mode === "stopped")
    return { kind: "stopped", reason: "explicit stop; not a workflow verdict" };
  if (record.deadlineAt !== undefined && now >= record.deadlineAt || record.mode === "expired")
    return { kind: "expired", reason: "absolute deadline" };
  if (now < record.lastClockAt)
    return hold("clock rollback");
  if (record.mode === "suspended")
    return hold("suspended");
  if (record.pendingAdmission)
    return hold("unresolved admission; read-only reconciliation only");
  if (record.policy.maxWakes !== undefined && record.wakesReserved >= record.policy.maxWakes)
    return hold("lifetime wake cap");
  if (now < record.nextWakeAt)
    return hold("cooldown");
  if (!run || run.id !== record.binding.runID || run.ownerID !== record.ownerID || run.projectID !== record.binding.projectID || run.directory !== record.binding.directory || run.fingerprint !== record.binding.runFingerprint)
    return hold("raw run unavailable or binding mismatch");
  const lifecycleInspection = run.status === "interrupted" && run.interruption !== undefined && run.interruption.at <= now && run.interruption.at <= run.updated && run.sessionIDs.length === 0 && run.checkpoints.some((item) => item.response === undefined);
  if (!["running", "waiting"].includes(run.status) && !lifecycleInspection)
    return hold(`workflow ${run.status}; interruption intent is not inferred`);
  if (run.checkpoints.some((item) => item.response === undefined && item.reviewer !== "coordinator"))
    return hold("human or legacy checkpoint");
  if (!observation || observation.kind === "unavailable")
    return hold(observation?.reason ?? "observation unavailable");
  if (observation.at > now || now - observation.at > 30000)
    return hold("stale observation");
  if (observation.ownerID !== record.ownerID || observation.runID !== run.id || observation.directory !== run.directory)
    return hold("observation scope mismatch");
  const owner = observation.sessions.find((item) => item.id === record.ownerID);
  if (!owner || owner.projectID !== run.projectID)
    return hold("owner observation unavailable");
  if (run.sessionIDs.some((id) => !observation.sessions.some((item) => item.id === id)))
    return hold("worker observation incomplete");
  for (const item of observation.sessions) {
    if (item.permission || item.form || item.queued || item.revert || item.interrupted)
      return hold("input, permission, form, revert or interruption hold");
  }
  if (owner.busy)
    return hold("owner busy");
  if (now - owner.idleAt < record.policy.idleGraceMs)
    return hold("idle grace");
  if (now - run.updated < record.policy.stalledMs)
    return hold("progress grace");
  return { kind: "wake", reason: "idle owner; stalled recorded progress" };
}

// src/heartbeat-transport.ts
import { Service } from "@opencode/client/service";
import { readFile } from "node:fs/promises";
import { z as z5 } from "zod";
var unavailable = "Existing compatible service unavailable; connect-only runner will not start it";
var Version = z5.enum(["2.0.26", "2.0.28"]);
var Registration = z5.object({
  url: z5.string().transform((value, context) => {
    const native = /^(https?:\/\/)(::1|::):([0-9]+)\/?$/.exec(value);
    const normalized = native ? `${native[1]}[${native[2]}]:${native[3]}` : value;
    if (!/^https?:\/\/(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|\[::\])(?::[0-9]+)?\/?$/.test(normalized)) {
      context.addIssue({ code: "custom", message: "Heartbeat requires an unambiguous loopback service" });
      return z5.NEVER;
    }
    try {
      const url = new URL(normalized);
      if (url.port === "0")
        throw new Error("Invalid port");
      if (url.hostname === "0.0.0.0")
        url.hostname = "127.0.0.1";
      if (url.hostname === "[::]")
        url.hostname = "[::1]";
      return url.toString();
    } catch {
      context.addIssue({ code: "custom", message: "Heartbeat requires a valid loopback service" });
      return z5.NEVER;
    }
  }),
  pid: z5.number().int().positive(),
  version: Version,
  password: z5.string().optional()
});
var Info = z5.object({ pid: z5.number().int().positive(), version: Version });
var heartbeatFetch = Object.assign((input, init) => fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) }), { preconnect: fetch.preconnect });
async function heartbeatEndpoint(file) {
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error("Existing service registration unavailable; connect-only runner will not start it");
  });
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(unavailable);
  }
  const registration = Registration.safeParse(input);
  if (!registration.success) {
    if (registration.error.issues.some((issue) => issue.path[0] === "url"))
      throw new Error("Heartbeat requires a valid unambiguous loopback service");
    throw new Error(unavailable);
  }
  const { url, pid, password, version } = registration.data;
  const endpoint = { url, auth: password === undefined ? undefined : { type: "basic", username: "opencode", password } };
  try {
    const response = await heartbeatFetch(new URL("/api/info", url), { headers: Service.headers(endpoint), signal: AbortSignal.timeout(2000) });
    if (!response.ok)
      throw new Error(unavailable);
    const info = Info.parse(await response.json());
    if (info.pid !== pid || info.version !== version)
      throw new Error(unavailable);
    return endpoint;
  } catch {
    throw new Error(unavailable);
  }
}

// src/heartbeat-runner.ts
var RunnerConfig = z6.object({ protocol: z6.literal(1), serviceFile: z6.string(), hostDirectory: z6.string(), node: z6.string(), runner: z6.string(), intervalMs: z6.literal(60000), label: z6.string().regex(/^com\.opthreads\.heartbeat(?:\.[a-zA-Z0-9-]+)?$/), launchAgentsDirectory: z6.string() }).strict();
function absolute(path) {
  if (!isAbsolute(path))
    throw new Error("Heartbeat paths must be absolute");
  return path;
}
async function heartbeatConnection(config) {
  const endpoint = await heartbeatEndpoint(absolute(config.serviceFile));
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service2.headers(endpoint), fetch: heartbeatFetch });
  const rpc = client.rpc(HeartbeatRpc);
  return { client, rpc };
}
async function heartbeatOnce(config, shadow) {
  return heartbeatCycle(config, shadow, await heartbeatConnection(config));
}
async function heartbeatCycle(config, shadow, connection) {
  const { client, rpc } = connection;
  let afterOwnerID;
  const decisions = [];
  do {
    const page = SnapshotOutput.parse(await rpc.snapshot({ afterOwnerID, limit: 100 }, { location: { directory: config.hostDirectory } }));
    for (const entry of page.entries) {
      try {
        const observation = await heartbeatObserve(client, entry);
        if (shadow)
          decisions.push({ monitorID: entry.record.monitorID, observation, mode: entry.record.mode, wakesReserved: entry.record.wakesReserved, deadlineAt: entry.record.deadlineAt, decision: heartbeatProjectionDecision(entry.record, entry.run ?? undefined, observation, Date.now()) });
        else
          decisions.push(await rpc.apply({ ownerID: entry.record.ownerID, monitorID: entry.record.monitorID, expectedRevision: entry.record.revision, bindingEpoch: entry.record.binding.epoch, observation }, { location: { directory: config.hostDirectory } }));
      } catch (error) {
        decisions.push({ monitorID: entry.record.monitorID, ownerID: entry.record.ownerID, status: "unavailable", detail: String(error).slice(0, 2000) });
      }
    }
    afterOwnerID = page.next;
  } while (afterOwnerID);
  return { protocol: 1, shadow, decisions };
}
var xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function heartbeatPlist(config, configFile, stateDirectory) {
  const args = [config.node, config.runner, "run", "--config", configFile];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(config.label)}</string><key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${xml(config.hostDirectory)}</string><key>StandardOutPath</key><string>${xml(join(stateDirectory, "runner.log"))}</string><key>StandardErrorPath</key><string>${xml(join(stateDirectory, "runner.error.log"))}</string></dict></plist>
`;
}
function launchctl(...args) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error)
    throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function requireVacant(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error(`Heartbeat path already occupied; uninstall explicitly first: ${path}`);
}
async function heartbeatCli(args = process.argv.slice(2)) {
  const command = args.shift();
  const flags = new Map;
  let shadow = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--shadow") {
      shadow = true;
      continue;
    }
    if (!flag?.startsWith("--") || !args.length)
      throw new Error("Expected named option and value");
    flags.set(flag, args.shift());
  }
  const allowed = new Set(["--config", "--service-file", "--host-directory", "--node", "--label", "--launchagents-directory"]);
  for (const flag of flags.keys())
    if (!allowed.has(flag))
      throw new Error(`Unknown heartbeat option ${flag}`);
  const configFile = absolute(flags.get("--config") ?? join(homedir(), "Library", "Application Support", "op-threads-heartbeat", "config.json"));
  const stateDirectory = dirname(configFile);
  const domain = `gui/${process.getuid?.()}`;
  if (command === "install") {
    if (process.platform !== "darwin")
      throw new Error("Heartbeat installer supports macOS only");
    await requireVacant(configFile);
    const config = RunnerConfig.parse({
      protocol: 1,
      serviceFile: absolute(flags.get("--service-file") ?? ""),
      hostDirectory: absolute(flags.get("--host-directory") ?? ""),
      node: await realpath(absolute(flags.get("--node") ?? process.execPath)),
      runner: await realpath(fileURLToPath(import.meta.url)),
      intervalMs: 60000,
      label: flags.get("--label") ?? "com.opthreads.heartbeat",
      launchAgentsDirectory: absolute(flags.get("--launchagents-directory") ?? join(homedir(), "Library", "LaunchAgents"))
    });
    if (!(await stat(config.hostDirectory)).isDirectory())
      throw new Error("Stable host directory unavailable");
    const isolatedTest = config.label !== "com.opthreads.heartbeat" && stateDirectory.includes("/.audit/recovery/heartbeat/") && config.launchAgentsDirectory.startsWith(`${stateDirectory}/`) && config.hostDirectory.startsWith(`${stateDirectory}/`);
    if (!isolatedTest && (config.hostDirectory.includes(".opencode-workflows") || config.runner.includes(".opencode-workflows")))
      throw new Error("Install from stable packaged paths, not task worktrees");
    const plist = join(config.launchAgentsDirectory, `${config.label}.plist`);
    await requireVacant(plist);
    const existing = launchctl("print", `${domain}/${config.label}`);
    if (existing.code === 0)
      throw new Error("Heartbeat label already loaded; uninstall explicitly first");
    if (existing.code !== 113 || !existing.stderr.includes("Could not find service"))
      throw new Error(`Cannot establish vacant Heartbeat label: ${existing.stderr}`);
    await heartbeatOnce(config, true);
    await mkdir(stateDirectory, { recursive: true, mode: 448 });
    await mkdir(config.launchAgentsDirectory, { recursive: true });
    const created = [];
    async function create(path, contents) {
      const file = await open(path, "wx", 384);
      try {
        created.push({ path, identity: await file.stat() });
        await file.writeFile(contents);
      } finally {
        await file.close();
      }
    }
    let bootstrapped = false;
    try {
      await create(configFile, JSON.stringify(config, null, 2));
      await create(plist, heartbeatPlist(config, configFile, stateDirectory));
      const boot = launchctl("bootstrap", domain, plist);
      if (boot.code !== 0)
        throw new Error(`LaunchAgent bootstrap failed: ${boot.stderr}`);
      bootstrapped = true;
      const readback = launchctl("print", `${domain}/${config.label}`);
      if (readback.code !== 0)
        throw new Error("LaunchAgent readback failed after successful bootstrap; configuration retained for explicit uninstall");
      return { installed: true, configFile, readback };
    } catch (error) {
      if (!bootstrapped)
        for (const file of created.reverse()) {
          const current = await lstat(file.path).catch((cause) => {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
              return;
            throw cause;
          });
          if (current?.dev === file.identity.dev && current.ino === file.identity.ino)
            await rm(file.path);
        }
      throw error;
    }
  }
  const config = RunnerConfig.parse(JSON.parse(await readFile2(configFile, "utf8")));
  if (command === "status") {
    const launcher = process.platform === "darwin" ? launchctl("print", `${domain}/${config.label}`) : { code: -1, stdout: "", stderr: "unsupported platform" };
    const observation = await heartbeatOnce(config, true).then((result) => ({ available: true, result }), (error) => ({ available: false, reason: String(error) }));
    return { config, launcher, observation };
  }
  if (command === "uninstall") {
    if (process.platform !== "darwin")
      throw new Error("Heartbeat uninstall supports macOS only");
    const stopped = launchctl("bootout", `${domain}/${config.label}`);
    let readback = launchctl("print", `${domain}/${config.label}`);
    for (let attempt = 0;readback.code === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      readback = launchctl("print", `${domain}/${config.label}`);
    }
    if (readback.code === 0)
      throw new Error("LaunchAgent still loaded; configuration retained");
    if (readback.code !== 113 || !readback.stderr.includes("Could not find service"))
      throw new Error("LaunchAgent absence unavailable; configuration retained");
    await rm(join(config.launchAgentsDirectory, `${config.label}.plist`), { force: true });
    await rm(configFile);
    return { uninstalled: true, stopped, readback, detail: "monitor records and logs retained; no workflow control" };
  }
  if (command === "once")
    return heartbeatOnce(config, shadow);
  if (command !== "run" || shadow)
    throw new Error("Usage: op-threads-heartbeat install|run|once --shadow|status|uninstall [--config absolute-path]");
  for (;; ) {
    try {
      process.stdout.write(`${JSON.stringify(await heartbeatOnce(config, false))}
`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ unavailable: String(error), at: Date.now() })}
`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}

// scripts/heartbeat-cli.ts
try {
  const output = await heartbeatCli();
  process.stdout.write(`${JSON.stringify(output)}
`);
} catch (error) {
  process.stderr.write(`${String(error)}
`);
  process.exitCode = 1;
}
