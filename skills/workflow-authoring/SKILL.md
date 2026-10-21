---
name: Workflow authoring
description: Author and run durable dynamic JavaScript workflows in OpenCode with parallel agents, structured handoffs, and resumable progress.
---

# Workflow authoring

Use a workflow for broad independent work or a pipeline whose later steps consume earlier results. Keep small, tightly coupled tasks with one owner.

For work across repositories, put the coordinator session in a directory that contains the intended sources, then set each step's `directory` to its repository. The worker uses that repository's OpenCode project for worktree isolation. Choose the scoped common ancestor before starting the run; a prompt mentioning another absolute path does not grant directory access.

When a step needs a directory outside its location, such as a reference repository, list it in the step's `paths`. The worker can then use that directory and its subdirectories without asking, within its `access`: a read step still cannot edit files or run commands there. A step's `directory` may also be inside a granted path if its whole project, meaning its git worktree or the directory itself outside a repository, is granted and no explicit `external_directory` deny matches anything in it. Explicit `external_directory` denies from the coordinator or the role still win. Without a grant, a directory that the coordinator would have to approve raises an approval request in a write worker's tab, and the step waits for the answer. Read steps follow their role's `external_directory` rules.

1. Define the result, named slices, and verification predicate. For VERA tasks, retain the selected protocol and role profiles.
2. Read [the runtime contract](references/runtime.md). Write a script with a literal `export const meta` first, named agent steps, and a final JSON result.
3. Call `workflows_start` with a unique task key, `script` or saved `name`, JSON `args`, and suitable concurrency. Omit task budgets unless the user requested them. It returns immediately.
4. Continue independent work. The runner delivers a final notification. Use `tools.workflows.inspect` for evidence and `tools.workflows.control` for pause, stop, resume, and checkpoint responses. Never infer success from an idle worker. After a stop, a failure, or a script fix, start a new run with a new key and `resumeFrom: <runID>` to reuse that run's completed steps whose key and input are unchanged.
5. Inspect the result and the affected artifacts before giving the final verdict. Save a useful script with `tools.workflows.save`; its arguments and transcripts are not saved with it.

`workflows_start` and the worker's `workflows_result` are native tools. The other workflow tools, including heartbeats, are Code Mode tools: call them inside `execute` as `tools.workflows.<name>`, for example `return await tools.workflows.inspect({ runID });`. If one is missing from the catalog, run `search({ namespace: "workflows" })` inside `execute`. Older plugin versions expose them as native `workflows_<name>` tools.

Every step selects an actual configured `agent`. Use `vera-operator-readonly` for discovery, `vera-engineer` for implementation, and `vera-auditor-readonly` for independent review. Model choices remain in the profiles. Workflow workers are leaves. Any user-supplied run budgets also cover nested workflows.

Budgets are opt-in. Do not estimate or invent `tokenBudget`, `maxAgents`, `agentTimeoutMs`, `timeoutMs`, retry or round limits, heartbeat wake caps, or monitoring deadlines. Leave those fields unset unless the user supplies a limit. If the user asks for a budget without giving a value, ask for the value instead of estimating it. An omitted budget means no task budget, not an estimated fallback. Preserve explicitly configured user limits. Concurrency and worker capacity are separate settings.

Use `access: "read"` for investigations. It denies edits and shell commands. Real command-based verification needs a suitably permitted worker with `access: "write"`, even when its intended task is only running tests. Use `isolation: "worktree"` for independent implementations and return the retained directory and changed paths. Give subsequent verification the same directory. The root owns integration. When the run ends, Threads removes step worktrees that hold no uncommitted changes and no commits outside a branch, so ask writers whose work outlives the run to commit to a named branch and return its name.

Verification evidence is part of the handoff. A completed run means the script ran to the end, not that every step passed: read each step's verdict before giving yours. When the script needs a decision, put it in the step's schema and branch on it. Do not replace execution evidence with reviewer votes. A workflow does not expand the user's authorization for external actions.

Workers finish required commands and inspect their results before reporting or ending their execution. Keep dependent checks in a foreground tool call; if a tool backgrounds them, collect its completion before finishing. A worker that ends without a report fails its step; the engine does not remind it. Native idle while a command is still running is not task completion.

For requested unattended monitoring, use the packaged `tools.workflows.heartbeat_*` Code Mode tools and shared runner described in [Workflow heartbeats](../../docs/heartbeat.md). Enroll the recorded run instead of creating a project-specific monitor. Heartbeat reminders ask for inspection; they do not answer checkpoints or establish completion. Mark an authorized coordinator review with `checkpoint(prompt, { key, reviewer: "coordinator" })`; checkpoints default to human review.

## Example

```javascript
export const meta = {
  name: "module-audit",
  description: "Audit named modules and return source-backed findings",
};

await phase("Audit");
const findings = await pipeline(args.modules, module => agent(
  `Audit ${module} for ${args.check}. Read the actual source. Return concrete findings with paths and line numbers.`,
  {
    key: `audit:${module}`,
    agent: "vera-engineer-readonly",
    access: "read",
    schema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    },
  },
));
return findings;
```

Invoke with structured arguments, for example `args: { modules: ["src/auth", "src/billing"], check: "missing authorization checks" }`. The default concurrency is three; plugin options can override it. The `workflows_start` schema shows explicitly configured limits. Do not derive a `maxAgents` budget from the planned slices.

The example returns candidate findings. Add an independent confirmation stage when the task requires a verified report.
