import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { threads } from "./threads";
import { heartbeat } from "./heartbeat";
import { workflowEngine } from "./workflow-engine";
import { WorkflowControl, WorkflowsRpc } from "./workflow-rpc";
import { savedWorkflows, SavedWorkflow } from "./workflow-saved";
import { WorkflowLimits, WorkflowPrune, WorkflowPruneResult, WorkflowResult, WorkflowRun, WorkflowStart, WorkflowSummary, workflowSummary } from "./workflow-types";

export type WorkflowStartPermission = Parameters<Plugin.Context["permission"]["assert"]>[0];

export function workflowStartPermission(
  input: Pick<WorkflowStart, "key" | "name" | "resumeFrom">,
  tool: Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id">,
): WorkflowStartPermission {
  const target = input.name === undefined ? "an inline workflow script" : `saved workflow ${input.name}`;
  const resume = input.resumeFrom === undefined ? "" : `, reusing completed steps of ${input.resumeFrom}`;
  return {
    sessionID: tool.sessionID,
    agent: tool.agent,
    action: "workflows_start",
    resources: [input.name ?? "*"],
    metadata: {
      description: `Start ${target} with key ${input.key}${resume}`,
      key: input.key,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.resumeFrom === undefined ? {} : { resumeFrom: input.resumeFrom }),
    },
    source: { type: "tool", messageID: tool.messageID, id: tool.id },
  };
}

export async function workflows(
  ctx: Plugin.Context,
  workers: ReturnType<typeof threads>,
  models: Map<SessionContext["sessionID"], SessionContext["model"]>,
  maxWorkers: number,
) {
  const concurrency = WorkflowLimits.shape.concurrency.parse(ctx.options.workflowConcurrency);
  const maxAgents = WorkflowStart.shape.maxAgents.parse(ctx.options.workflowMaxAgents);
  const cleanupWorktrees = z.boolean().default(true).parse(ctx.options.workflowWorktreeCleanup);
  const startInput = WorkflowStart.safeExtend({
    concurrency: WorkflowLimits.shape.concurrency.default(concurrency),
    maxAgents: WorkflowStart.shape.maxAgents.default(maxAgents),
  });
  const saved = savedWorkflows(ctx.location.directory, ctx.location.project.canonical);
  const engine = workflowEngine(ctx, workers, {
    maxWorkers,
    cleanupWorktrees,
    loadSaved: (name: string) => saved.load(name),
    warmWorker: (sessionID: string) => ctx.session.command({ sessionID, name: "workflow-refresh", text: "" }),
  });
  await heartbeat(ctx);
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
      return saved.save(name, run.script, scope);
    },
  });
  await ctx.session.hook("prompt", (event) => engine.preparePrompt(event.sessionID, event.messageID));
  await ctx.session.hook("context", (event) => engine.prepareContext(event.sessionID));
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "workflows", description: "List, inspect, control, save, and prune durable workflow runs, and manage heartbeat monitors. Start runs with the native workflows_start tool." });
    editor.add({
      name: "start",
      description: "Start a dynamic JavaScript workflow in the background. Start one only when the user asked for a workflow, invoked /workflow-run or a saved workflow by name, or a loaded skill instructs it; otherwise propose the workflow with its rough agent count and ask first. Load workflow-authoring first. Supply script or a saved name, a stable retry key, and optional JSON args. The runner owns parallel agents, structured results, checkpoints, and resumable progress. Keep the same key and identical inputs for an exact retry. To reuse an ended run's completed steps, pass its ID as resumeFrom with a new key. Configured role permissions apply to every agent. An agent step's paths option grants existing absolute directories outside its location for use without asking, within its access; explicit external_directory denies still win. Without a grant, a write worker gets an approval request in its tab where you would be asked, unless its role denies the directory; read workers follow their role's rules. Returns immediately; inspect or control the run by ID through execute with tools.workflows.inspect and tools.workflows.control.",
      input: startInput,
      output: WorkflowSummary,
      options: { namespace: "workflows", codemode: false },
      execute: async (input, tool) => {
        const request = startInput.parse(input);
        const model = models.get(tool.sessionID);
        if (!model) throw new Error("Workflow start requires a resolved session model");
        // Don't catch: a plain rejection must propagate to end the step.
        await ctx.permission.assert(workflowStartPermission(request, tool));
        const run = await engine.start(tool.sessionID, request, { agent: tool.agent, model });
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
      options: { namespace: "workflows", codemode: true },
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
      options: { namespace: "workflows", codemode: true },
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
      options: { namespace: "workflows", codemode: true },
      execute: async (input, tool) => {
        const run = await engine.control(tool.sessionID, input);
        await rpc.events.emit("updated", { ownerID: tool.sessionID, runID: run.id });
        const output = workflowSummary(run);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "prune",
      description: "List step worktrees left by finished workflow runs in this project, and remove them with apply: true. Dry run by default; it changes nothing. Apply removes only checkouts without uncommitted or untracked changes, whose commits a branch, tag, or remote contains, and that hold no other worktree or running worker. It never forces removal or deletes branches, run records, or sessions. Worktrees of active, paused, waiting, or interrupted runs are kept. olderThanDays limits it to runs that finished at least that many days ago.",
      input: WorkflowPrune,
      output: WorkflowPruneResult,
      options: { namespace: "workflows", codemode: true, permission: "edit" },
      execute: async (input, tool) => {
        const output = await engine.prune(tool.sessionID, input);
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
      description: "Save a run's JavaScript as a reusable workflow in the current project's .opencode/workflows or your OpenCode config's workflows directory. Set overwrite: true to replace an existing file of that name. Saves the script, not run arguments or worker transcripts.",
      input: z.object({ runID: z.string(), name: z.string(), scope: z.enum(["project", "user"]).default("project"), overwrite: z.boolean().default(false) }).strict(),
      output: z.object({ path: z.string() }),
      options: { namespace: "workflows", codemode: true, permission: "edit" },
      execute: async (input, tool) => {
        const run = await engine.get(tool.sessionID, input.runID);
        const output = await saved.save(input.name, run.script, input.scope, input.overwrite);
        return { content: JSON.stringify(output), output };
      },
    });
    editor.add({
      name: "saved",
      description: "List reusable workflow scripts available in this project and your OpenCode configuration, with each script's description and optional whenToUse. Start one with workflows_start and its name. Project names take precedence over user names.",
      input: z.object({}).strict(),
      output: z.object({ workflows: z.array(SavedWorkflow) }),
      options: { namespace: "workflows", codemode: true },
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
  await ctx.command.transform((editor) => {
    editor.add({
      name: "workflow-refresh",
      description: "Activate workflow tools for this location without prompting the agent",
      execute: async () => {},
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
  });
  return () => engine.dispose();
}
