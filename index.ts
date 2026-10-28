import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { z } from "zod";
import { requireOpenCode21 } from "./src/opencode-compat";
import { Report, ThreadsRpc, WorkerView } from "./src/rpc";
import { Interrupt, Rule, RulePut, RuleTarget, Send, Spawn, WorkerTarget, threads } from "./src/threads";
import { workflows } from "./src/workflows";

export default Plugin.define({
  id: "op-threads",
  async setup(ctx) {
    requireOpenCode21(ctx.app?.version);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4)
      .parse(ctx.options.maxWorkers);
    const workers = threads(ctx, limit);
    await ctx.session.hook("prompt", (event) => {
      return workers.preparePrompt(
        event.sessionID, event.messageID, event.metadata?.opThreadsCallerAgent,
      );
    });
    const models = new Map<
      SessionContext["sessionID"],
      SessionContext["model"]
    >();
    await ctx.session.hook("context", async (event) => {
      models.set(event.sessionID, event.model);
      const diagnostics = await workers.reconcileFollowups(event.sessionID);
      if (diagnostics.length) event.system.push({ type: "text", text:
        `Managed follow-up recovery is incomplete; this is not task success. Failed records remain pending for retry. Inspect the named worker conversation and native/storage error, resolve the cause, then retry the identical threads_send key or allow the next recovery pass.\n${diagnostics.join("\n")}` });
    });
    await ctx.rpc.register(ThreadsRpc, {
      snapshot: async ({ coordinatorIDs }) => ({
        workers: (await Promise.all(coordinatorIDs.map((id) => workers.list(id, "snapshot")))).flat(),
      }),
      restore: async ({ coordinatorIDs }) => ({
        workers: (await Promise.all(coordinatorIDs.map(workers.restore))).flat(),
      }),
    });
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "threads",
        description: "List, interrupt, and hide your managed workers, and set standing rules on them. Spawn, follow-up, and report are the native threads_spawn, threads_send, and threads_report tools.",
      });
      editor.add({
        name: "spawn",
        description:
          "Delegate a task to a top-level worker in an existing absolute directory. Set agent to a configured profile (for example vera-core); its prompt, model preference, and permissions apply. Omit agent to inherit your active agent and model. Set paths to existing absolute directories outside that directory that the worker may use without asking, within its permissions; explicit external_directory denies still win. Other directories follow the worker's permissions, and an inherited external_directory ask becomes an approval request in the worker's tab. Native subagent remains available within the selected profile's permissions and task's delegation limits. Workers cannot call threads_spawn. Reuse key only for identical requests, including agent and paths.",
        input: Spawn,
        output: WorkerView,
        options: {
          namespace: "threads",
          permission: "subagent",
          codemode: false,
        },
        execute: async (input, tool) => {
          const model = models.get(tool.sessionID);
          if (!model)
            throw new Error("Spawn requires a resolved session context model");
          const output = await workers.spawn(tool.sessionID, input, {
            agent: tool.agent,
            model,
          });
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "list",
        description:
          "List your managed workers, last native execution outcomes, and explicit reports. Idle is not task success.",
        input: z.object({}).strict(),
        output: z.object({ workers: z.array(WorkerView) }),
        options: { namespace: "threads", codemode: true },
        execute: async (_input, tool) => {
          const output = { workers: await workers.list(tool.sessionID) };
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "send",
        description:
          "Send a follow-up to your worker. Reuse key for an identical retry. A separate completion notice names this message and its native outcome; inspect the evidence before accepting it. The original report remains unchanged. delivery defaults to queue, which runs the message after the worker's current run; steer delivers it to a busy worker at its next step. If steering fails after admission, the message stays queued and steerError says why. Sending also redelivers follow-ups that threads_interrupt held, queued in their original order. resumedFollowups lists those redelivered; failedFollowups lists each one that failed, with its error, and recovery retries it.",
        input: Send,
        output: z.object({
          workerID: z.string(), messageID: z.string(), steerError: z.string().optional(), resumedFollowups: z.array(z.string()).optional(),
          failedFollowups: z.array(z.object({ messageID: z.string(), error: z.string() })).optional(),
        }),
        options: { namespace: "threads", codemode: false },
        execute: async (input, tool) => {
          const output = await workers.send(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "interrupt",
        description: "Interrupt your worker without claiming task success. Follow-ups that have not started are held, not run, and listed in heldFollowups. Your next threads_send to this worker resumes them. Set dropHeld to remove them from the worker's inbox instead: droppedFollowups lists those removed, and failedDrops lists any still held, with the error. Interrupting an idle worker with dropHeld drops follow-ups an earlier interrupt held. failedRequeues lists steered follow-ups that could not be moved back to the queue; a later send may run them ahead of queued ones, and the next interrupt retries the move.",
        input: Interrupt,
        output: WorkerView.extend({
          heldFollowups: z.array(z.string()), droppedFollowups: z.array(z.string()).optional(),
          failedDrops: z.array(z.object({ messageID: z.string(), error: z.string() })).optional(),
          failedRequeues: z.array(z.object({ messageID: z.string(), error: z.string() })).optional(),
        }),
        options: { namespace: "threads", codemode: true },
        execute: async (input, tool) => {
          const output = await workers.interrupt(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      const Rules = z.object({ workerID: z.string(), rules: z.array(Rule) });
      editor.add({
        name: "set_rule",
        description: "Set a standing rule on your worker, such as \"don't edit src/config.ts\". The worker sees it at its next step, and it stays in its context, including after compaction, until you remove it. Setting an existing key replaces its text. Returns the worker's current rules.",
        input: RulePut,
        output: Rules,
        options: { namespace: "threads", codemode: true },
        execute: async (input, tool) => {
          const output = await workers.setRule(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "remove_rule",
        description: "Remove a standing rule from your worker. The worker is told at its next step that the rule no longer applies. Returns the worker's current rules.",
        input: RuleTarget,
        output: Rules,
        options: { namespace: "threads", codemode: true },
        execute: async (input, tool) => {
          const output = await workers.removeRule(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "rules",
        description: "List the standing rules you set on your worker.",
        input: WorkerTarget,
        output: Rules,
        options: { namespace: "threads", codemode: true },
        execute: async (input, tool) => {
          const output = await workers.rules(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "hide",
        description: "Hide a worker you no longer need from the Threads list without deleting its conversation or report. Only its coordinator may hide it. A running, selected, or attention-needed worker stays visible until idle. Use /threads to restore hidden workers.",
        input: WorkerTarget,
        output: WorkerView,
        options: { namespace: "threads", codemode: true },
        execute: async (input, tool) => {
          const output = await workers.hide(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "report",
        description:
          "Report your managed task verdict and evidence to your coordinator. Identical retries return the original report; conflicting reports are rejected. Use a new spawn key for a new task.",
        input: Report,
        output: z.object({ workerID: z.string(), report: Report }),
        options: { namespace: "threads", codemode: false },
        execute: async (input, tool) => {
          const output = await workers.report(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
    });
    return workflows(ctx, workers, models, limit);
  },
});
