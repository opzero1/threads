import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { Json, WorkflowRun, WorkflowSummary } from "./workflow-types";

export const WorkflowControl = z.object({
  runID: z.string().min(1),
  action: z.enum(["pause", "resume", "stop"]),
  checkpointKey: z.string().optional(),
  response: Json.optional(),
}).strict();

export const WorkflowsRpc = Rpc.define({
  id: "workflows",
  methods: {
    snapshot: {
      input: z.object({ ownerID: z.string() }).strict(),
      output: z.object({ runs: z.array(WorkflowSummary) }),
      errors: {},
    },
    inspect: {
      input: z.object({ ownerID: z.string(), runID: z.string() }).strict(),
      output: WorkflowRun,
      errors: {},
    },
    control: {
      input: WorkflowControl.extend({ ownerID: z.string() }).strict(),
      output: WorkflowRun,
      errors: {},
    },
    save: {
      input: z.object({ ownerID: z.string(), runID: z.string(), name: z.string(), scope: z.enum(["project", "user"]) }).strict(),
      output: z.object({ path: z.string() }),
      errors: {},
    },
  },
  events: {
    updated: { schema: z.object({ ownerID: z.string(), runID: z.string() }) },
  },
});
