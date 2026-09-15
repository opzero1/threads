import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const Report = z
  .object({
    verdict: z.enum(["PASS", "PASS WITH NOTES", "FAIL", "INCONCLUSIVE"]),
    summary: z.string().min(1),
    evidence: z.array(z.string()),
  })
  .strict();

export const WorkerView = z.object({
  workerID: z.string(),
  coordinatorID: z.string(),
  key: z.string(),
  title: z.string(),
  directory: z.string(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).nullable(),
  report: Report.nullable(),
  hidden: z.boolean(),
});

export const ThreadsRpc = Rpc.define({
  id: "threads",
  methods: {
    snapshot: {
      input: z
        .object({ coordinatorIDs: z.array(z.string()).max(100) })
        .strict(),
      output: z.object({ workers: z.array(WorkerView) }),
      errors: {},
    },
    restore: {
      input: z.object({ coordinatorIDs: z.array(z.string()).max(100) }).strict(),
      output: z.object({ workers: z.array(WorkerView) }),
      errors: {},
    },
  },
  events: {},
});
