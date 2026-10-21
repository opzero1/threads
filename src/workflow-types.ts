import { z } from "zod";
import { Report } from "./rpc";

export const WORKFLOW_DIAGNOSTIC_JSON_BYTES = 4_096;
export const WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES = 512;
export const WORKFLOW_CONTROL_HEADROOM = 64 * 1024;

export const Json = z.json();
export type Json = z.infer<typeof Json>;
export const WorkflowModel = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional(),
});
export const WorkflowLimits = z.object({
  concurrency: z.number().int().min(1).max(8).default(3),
  // Old journals compacted these finite defaults; null explicitly means unbounded.
  maxAgents: z.number().int().min(1).max(1000).nullable().default(4),
  agentTimeoutMs: z.number().int().min(1000).max(604800000).nullable().default(1800000),
  timeoutMs: z.number().int().min(1000).max(604800000).nullable().default(86400000),
  tokenBudget: z.number().int().positive().nullable().optional(),
});
export const WorkflowStart = WorkflowLimits.extend({
  maxAgents: WorkflowLimits.shape.maxAgents.default(null),
  agentTimeoutMs: WorkflowLimits.shape.agentTimeoutMs.default(null),
  timeoutMs: WorkflowLimits.shape.timeoutMs.default(null),
  key: z.string().min(1).max(120),
  script: z.string().min(1).max(200000).optional(),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
  args: Json.default(null),
  resumeFrom: z.string().min(1).optional(),
}).strict().refine((value) => Boolean(value.script) !== Boolean(value.name), {
  message: "Supply exactly one of script or saved workflow name",
});
export type WorkflowStart = z.infer<typeof WorkflowStart>;

export const MAX_GRANTED_PATHS = 16;
export const GrantedPaths = z.array(z.string().min(1).max(4096)).max(MAX_GRANTED_PATHS);

export const WorkflowAgentInput = z.object({
  key: z.string().min(1).max(120),
  prompt: z.string().min(1).max(100000),
  agent: z.string().min(1),
  label: z.string().min(1).max(160).optional(),
  phase: z.string().min(1).max(160).optional(),
  schema: z.record(z.string(), Json).optional(),
  access: z.enum(["read", "write"]).default("read"),
  isolation: z.enum(["shared", "worktree"]).default("shared"),
  directory: z.string().min(1).optional(),
  paths: GrantedPaths.optional(),
  timeoutMs: z.number().int().min(1000).max(604800000).optional(),
}).strict();
export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInput>;
export const WorkflowResult = Report.extend({ result: Json }).strict();
export type WorkflowResult = z.infer<typeof WorkflowResult>;
export const WorkflowUsage = z.object({
  tokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  measured: z.boolean(),
});

const StepBase = z.object({
  key: z.string(),
  fingerprint: z.string(),
  index: z.number().int().nonnegative(),
  input: WorkflowAgentInput,
  workerID: z.string(),
  spawnKey: z.string(),
  created: z.number(),
  phase: z.string(),
  directory: z.string(),
  model: WorkflowModel,
  profileFingerprint: z.string(),
});
export const WorkflowStep = z.discriminatedUnion("status", [
  StepBase.extend({ status: z.literal("prepared") }),
  StepBase.extend({ status: z.literal("running"), usage: WorkflowUsage.optional() }),
  StepBase.extend({
    status: z.literal("completed"),
    completed: z.number(),
    report: WorkflowResult,
    usage: WorkflowUsage,
    // The run whose worker produced this report; such a step spent nothing in this run.
    reusedFrom: z.string().optional(),
  }),
  StepBase.extend({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
    usage: WorkflowUsage.optional(),
  }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;
export const WorkflowCheckpoint = z.object({
  key: z.string(),
  prompt: z.string(),
  reviewer: z.enum(["human", "coordinator"]).optional(),
  response: Json.optional(),
});
export const WorkflowSettlement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), key: z.string(), outcome: z.enum(["success", "failure"]), error: z.string().optional() }),
  z.object({ kind: z.literal("checkpoint"), key: z.string(), response: Json }),
]);
export type WorkflowSettlement = z.infer<typeof WorkflowSettlement>;
export const WorktreeKeptReason = z.enum(["changes", "commits", "nested", "in-use", "unregistered", "error"]);
export const WorkflowWorktreeOutcome = z.object({
  key: z.string(),
  directory: z.string(),
  outcome: z.enum(["removed", "kept", "missing"]),
  reason: WorktreeKeptReason.optional(),
  message: z.string().optional(),
  at: z.number(),
});
export type WorkflowWorktreeOutcome = z.infer<typeof WorkflowWorktreeOutcome>;
export const WorkflowRun = z.object({
  version: z.literal(1),
  // Written only by older versions; "legacy-bounded" runs stay readable but cannot resume.
  helperPolicy: z.enum(["legacy-bounded", "optional-counts"]).optional(),
  id: z.string(),
  key: z.string(),
  ownerID: z.string(),
  callerAgent: z.string(),
  model: WorkflowModel,
  projectID: z.string(),
  directory: z.string(),
  name: z.string(),
  description: z.string(),
  script: z.string(),
  args: Json,
  fingerprint: z.string(),
  resumeFrom: z.string().optional(),
  limits: WorkflowLimits,
  status: z.enum(["running", "pausing", "paused", "stopping", "stopped", "waiting", "interrupted", "failed", "completed"]),
  interruption: z.object({
    kind: z.enum(["engine-disposed", "lease-lost"]),
    priorStatus: z.enum(["running", "waiting"]),
    at: z.number().finite().nonnegative(),
  }).optional(),
  created: z.number(),
  updated: z.number(),
  finished: z.number().optional(),
  phase: z.string(),
  steps: z.array(WorkflowStep),
  logs: z.array(z.object({ time: z.number(), text: z.string() })),
  checkpoints: z.array(WorkflowCheckpoint),
  settlements: z.array(WorkflowSettlement).optional(),
  attention: z.object({
    checkpoints: z.array(z.string()),
    interruption: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deliveredInterruption: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).optional(),
  result: Json.optional(),
  error: z.string().optional(),
  deliveryID: z.string(),
  delivered: z.boolean(),
  worktreeCleanup: z.object({
    complete: z.boolean(),
    worktrees: z.array(WorkflowWorktreeOutcome),
  }).optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
export const WorkflowPrune = z.object({
  apply: z.boolean().default(false),
  olderThanDays: z.number().min(0).max(3650).optional(),
}).strict();
export const WorkflowPruneEntry = z.object({
  runID: z.string(),
  runStatus: WorkflowRun.shape.status,
  key: z.string(),
  directory: z.string(),
  outcome: z.enum(["removed", "would-remove", "kept"]),
  reason: z.enum([...WorktreeKeptReason.options, "unfinished"]).optional(),
  message: z.string().optional(),
});
export const WorkflowPruneResult = z.object({
  applied: z.boolean(),
  worktrees: z.array(WorkflowPruneEntry),
  counts: z.object({ removed: z.number(), wouldRemove: z.number(), kept: z.number() }),
});
export type WorkflowPruneResult = z.infer<typeof WorkflowPruneResult>;
export const WorkflowSummary = WorkflowRun.omit({ script: true, args: true, result: true, steps: true, logs: true, checkpoints: true, settlements: true, attention: true, fingerprint: true, callerAgent: true, deliveryID: true, delivered: true, worktreeCleanup: true }).extend({
  counts: z.object({ completed: z.number(), running: z.number(), failed: z.number(), total: z.number() }),
  usage: WorkflowUsage,
});
export type WorkflowSummary = z.infer<typeof WorkflowSummary>;
export function workflowSummary(run: WorkflowRun): WorkflowSummary {
  const completed = run.steps.filter((step) => step.status === "completed");
  const accounted = run.steps.flatMap((step) => "usage" in step && step.usage !== undefined ? [step.usage] : []);
  return WorkflowSummary.parse({
    ...run,
    counts: {
      completed: completed.length,
      running: run.steps.filter((step) => step.status === "running" || step.status === "prepared").length,
      failed: run.steps.filter((step) => step.status === "failed").length,
      total: run.steps.length,
    },
    usage: {
      tokens: accounted.reduce((total, item) => total + item.tokens, 0),
      cost: accounted.reduce((total, item) => total + item.cost, 0),
      measured: run.steps.length > 0 && run.steps.every((step) => step.status === "prepared" || ("usage" in step && step.usage?.measured === true)),
    },
  });
}
