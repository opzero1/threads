import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { z } from "zod";
import { threads } from "./threads";
import { workflowEngine } from "./workflow-engine";
import { WorkflowControl, WorkflowsRpc } from "./workflow-rpc";
import { savedWorkflows, SavedWorkflow } from "./workflow-saved";
import { WorkflowLimits, WorkflowResult, WorkflowRun, WorkflowStart, WorkflowSummary, workflowSummary } from "./workflow-types";

export async function workflows(
  ctx: Plugin.Context,
  workers: ReturnType<typeof threads>,
  models: Map<SessionContext["sessionID"], SessionContext["model"]>,
  maxWorkers: number,
) {
  const concurrency = WorkflowLimits.shape.concurrency.parse(ctx.options.workflowConcurrency);
  const maxAgents = WorkflowLimits.shape.maxAgents.parse(ctx.options.workflowMaxAgents);
  const startInput = WorkflowStart.safeExtend({
    concurrency: WorkflowLimits.shape.concurrency.default(concurrency),
    maxAgents: WorkflowLimits.shape.maxAgents.default(maxAgents),
  });
  const saved = savedWorkflows(ctx.location.directory, ctx.location.project.canonical);
  const engine = workflowEngine(ctx, workers, {
    maxWorkers,
    loadSaved: (name: string) => saved.load(name),
    warmWorker: (sessionID: string) => ctx.session.command({ sessionID, name: "workflow-refresh", text: "" }),
  });
  const rpc = await ctx.rpc.register(WorkflowsRpc, {
    snapshot: async ({ ownerID }) => ({ runs: (await engine.list(ownerID)).map(workflowSummary) }),
    inspect: ({ ownerID, runID }) => engine.get(ownerID, runID),
    control: async ({ ownerID, ...input }) => {
      const run = await engine.control(ownerID, input);
      await rpc.events.emit("updated", { ownerID, runID: run.id });
      return run;
    },
    save: async ({ ownerID, runID, name, scope }) => {
      const run = await engine.get(ownerID, runID);
      const result = await saved.save(name, run.script, scope);
      await refreshCommands();
      return result;
    },
  });
  await ctx.session.hook("prompt", (event) => engine.preparePrompt(event.sessionID, event.messageID));
  await ctx.session.hook("context", (event) => engine.prepareContext(event.sessionID));
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "workflows", description: "Durable background JavaScript workflows using native OpenCode agents" });
    editor.add({
      name: "start",
      description: "Start a dynamic JavaScript workflow in the background. Load workflow-authoring first. Supply script or a saved name, a stable retry key, and optional JSON args. The runner owns parallel agents, structured results, checkpoints, and resumable progress. Keep the same key and identical inputs for an exact retry. Configured role permissions apply to every agent. Returns immediately; inspect/control using the run ID.",
      input: startInput,
      output: WorkflowSummary,
      options: { namespace: "workflows", codemode: false },
      execute: async (input, tool) => {
        const model = models.get(tool.sessionID);
        if (!model) throw new Error("Workflow start requires a resolved session model");
        const run = await engine.start(tool.sessionID, startInput.parse(input), { agent: tool.agent, model });
        await rpc.events.emit("updated", { ownerID: tool.sessionID, runID: run.id });
        const output = workflowSummary(run);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "list",
      description: "List your dynamic workflow runs and recorded progress. The final result and explicit worker evidence determine task success.",
      input: z.object({}).strict(),
      output: z.object({ runs: z.array(WorkflowSummary) }),
      options: { namespace: "workflows", codemode: false },
      execute: async (_input, tool) => {
        const output = { runs: (await engine.list(tool.sessionID)).map(workflowSummary) };
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "inspect",
      description: "Read a workflow's saved script, phases, step sessions, structured reports, usage, checkpoints, and final result.",
      input: z.object({ runID: z.string().min(1) }).strict(),
      output: WorkflowRun,
      options: { namespace: "workflows", codemode: false },
      execute: async (input, tool) => {
        const output = await engine.get(tool.sessionID, input.runID);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "control",
      description: "Pause new workflow scheduling, stop active work, or explicitly resume the same recorded script. Resume a waiting checkpoint with checkpointKey and a JSON response. Only the owning session controls the run. Resume reconciles existing workers and recorded results.",
      input: WorkflowControl,
      output: WorkflowSummary,
      options: { namespace: "workflows", codemode: false },
      execute: async (input, tool) => {
        const run = await engine.control(tool.sessionID, input);
        await rpc.events.emit("updated", { ownerID: tool.sessionID, runID: run.id });
        const output = workflowSummary(run);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "result",
      description: "Submit the assigned workflow step's final verdict, evidence, and JSON result. Only the original workflow worker can submit. The runner validates result against the step's schema before accepting it. Correct validation errors and retry. PASS requires completed verification, INCONCLUSIVE is not a pass.",
      input: WorkflowResult,
      output: z.object({ accepted: z.literal(true) }),
      options: { namespace: "workflows", codemode: false },
      execute: async (input, tool) => {
        const output = await engine.result(tool.sessionID, input);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "save",
      description: "Save a run's JavaScript as a reusable workflow in the current project's .opencode/workflows or your OpenCode config's workflows directory. Existing files are never overwritten. Saves the script, not run arguments or worker transcripts.",
      input: z.object({ runID: z.string(), name: z.string(), scope: z.enum(["project", "user"]).default("project") }).strict(),
      output: z.object({ path: z.string() }),
      options: { namespace: "workflows", codemode: false, permission: "edit" },
      execute: async (input, tool) => {
        const run = await engine.get(tool.sessionID, input.runID);
        const output = await saved.save(input.name, run.script, input.scope);
        await refreshCommands();
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "saved",
      description: "List reusable workflow scripts available in this project and your OpenCode configuration. Project names take precedence over user names.",
      input: z.object({}).strict(),
      output: z.object({ workflows: z.array(SavedWorkflow) }),
      options: { namespace: "workflows", codemode: false },
      execute: async () => {
        const output = { workflows: await saved.list() };
        return { content: JSON.stringify(output), output };
      },
    });
  });
  const skillPath = fileURLToPath(new URL("../skills/workflow-authoring/SKILL.md", import.meta.url));
  const skill = await readFile(skillPath, "utf8");
  await ctx.skill.transform((editor) => editor.add({
    id: Skill.ID.make("workflow-authoring"),
    name: Skill.Name.make("Workflow authoring"),
    description: "Author and run durable dynamic JavaScript workflows in OpenCode: parallel agents, structured handoffs, worktrees, recovery, and VERA verification.",
    path: Skill.Info.fields.path.make(skillPath),
    content: skill.replace(/^---\n[\s\S]*?\n---\n/, ""),
  }));
  let commands = await saved.list();
  await ctx.command.transform((editor) => {
    editor.add({
      name: "workflow-refresh",
      description: "Reload saved workflow commands for this location",
      execute: refreshCommands,
    });
    editor.add({
      name: "workflow-run",
      description: "Ask the current agent to author and start a dynamic workflow",
      execute: ({ sessionID, prompt, delivery }) => ctx.session.prompt({
        ...prompt,
        sessionID,
        delivery,
        text: `Load workflow-authoring and use a dynamic workflow for this task. Choose explicit roles and verification requirements, then start it with workflows_start.\n\n${prompt.text}`,
      }).then(() => {}),
    });
    for (const command of commands) {
      editor.add({
        name: `workflow-${command.name}`,
        description: command.description,
        execute: ({ sessionID, prompt, delivery }) => ctx.session.prompt({
          ...prompt,
          sessionID,
          delivery,
          text: `Load workflow-authoring, then run saved workflow ${JSON.stringify(command.name)} through workflows_start with arguments from this request:\n\n${prompt.text}`,
        }).then(() => {}),
      });
    }
  });
  async function refreshCommands() {
    commands = await saved.list();
    await ctx.command.reload();
  }
  return () => engine.dispose();
}
