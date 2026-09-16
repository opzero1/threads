import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { z } from "zod";
import { Report, ThreadsRpc, WorkerView } from "./src/rpc";
import { Send, Spawn, WorkerTarget, threads } from "./src/threads";

export default Plugin.define({
  id: "op-threads",
  async setup(ctx) {
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
    await ctx.session.hook("context", (event) => {
      models.set(event.sessionID, event.model);
    });
    await ctx.rpc.register(ThreadsRpc, {
      snapshot: async ({ coordinatorIDs }) => ({
        workers: (await Promise.all(coordinatorIDs.map(workers.list))).flat(),
      }),
      restore: async ({ coordinatorIDs }) => ({
        workers: (await Promise.all(coordinatorIDs.map(workers.restore))).flat(),
      }),
    });
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "threads",
        description: "Independent managed worker sessions",
      });
      editor.add({
        name: "spawn",
        description:
          "Delegate a task to a top-level worker in an existing absolute directory. Set agent to a configured profile (for example vera-core); its prompt, model preference, and permissions apply. Omit agent to inherit your active agent and model. Native subagent remains available within the selected profile's permissions and task's delegation limits. Workers cannot call threads_spawn. Reuse key only for identical requests, including agent.",
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
        options: { namespace: "threads", codemode: false },
        execute: async (_input, tool) => {
          const output = { workers: await workers.list(tool.sessionID) };
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "send",
        description:
          "Send a follow-up to your worker. Reuse key for an identical retry.",
        input: Send,
        output: z.object({ workerID: z.string(), messageID: z.string() }),
        options: { namespace: "threads", codemode: false },
        execute: async (input, tool) => {
          const output = await workers.send(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "interrupt",
        description: "Interrupt your worker without claiming task success.",
        input: WorkerTarget,
        output: WorkerView,
        options: { namespace: "threads", codemode: false },
        execute: async (input, tool) => {
          const output = await workers.interrupt(tool.sessionID, input);
          return { content: JSON.stringify(output), output };
        },
      });
      editor.add({
        name: "hide",
        description: "Hide a worker you no longer need from the sidebar without deleting its conversation or report. Only its coordinator may hide it. Running, selected, or attention-needed tabs stay open until idle. Use /threads to restore hidden tabs.",
        input: WorkerTarget,
        output: WorkerView,
        options: { namespace: "threads", codemode: false },
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
  },
});
