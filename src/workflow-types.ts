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
  maxAgents: z.number().int().min(1).max(1000).default(4),
  agentTimeoutMs: z.number().int().min(1000).max(604800000).default(1800000),
  timeoutMs: z.number().int().min(1000).max(604800000).default(86400000),
  tokenBudget: z.number().int().positive().optional(),
});
export const WorkflowStart = WorkflowLimits.extend({
  key: z.string().min(1).max(120),
  script: z.string().min(1).max(200000).optional(),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
  args: Json.default(null),
}).strict().refine((value) => Boolean(value.script) !== Boolean(value.name), {
  message: "Supply exactly one of script or saved workflow name",
});
export type WorkflowStart = z.infer<typeof WorkflowStart>;

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
  response: Json.optional(),
});
export const WorkflowSettlement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), key: z.string(), outcome: z.enum(["success", "failure"]), error: z.string().optional() }),
  z.object({ kind: z.literal("checkpoint"), key: z.string(), response: Json }),
]);
export type WorkflowSettlement = z.infer<typeof WorkflowSettlement>;
export const WorkflowRun = z.object({
  version: z.literal(1),
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
  limits: WorkflowLimits,
  status: z.enum(["running", "pausing", "paused", "stopping", "stopped", "waiting", "interrupted", "failed", "completed"]),
  created: z.number(),
  updated: z.number(),
  phase: z.string(),
  steps: z.array(WorkflowStep),
  logs: z.array(z.object({ time: z.number(), text: z.string() })),
  checkpoints: z.array(WorkflowCheckpoint),
  settlements: z.array(WorkflowSettlement).optional(),
  result: Json.optional(),
  error: z.string().optional(),
  deliveryID: z.string(),
  delivered: z.boolean(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
export const WorkflowSummary = WorkflowRun.omit({ script: true, args: true, result: true, steps: true, logs: true, checkpoints: true, settlements: true, fingerprint: true, callerAgent: true, deliveryID: true, delivered: true }).extend({
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
