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
3. Call `workflows_start` with a unique task key, `script` or saved `name`, JSON `args`, and the smallest useful concurrency and agent limit. It returns immediately.
4. Continue independent work. The runner delivers a final notification. Use `workflows_inspect` for evidence and `workflows_control` for pause, stop, resume, and checkpoint responses. Never infer success from an idle worker.
5. Inspect the result and the affected artifacts before giving the final verdict. Save a useful script with `workflows_save`; its arguments and transcripts are not saved with it.

Every step selects an actual configured `agent`. Use `vera-operator-readonly` for discovery, `vera-engineer` for implementation, and `vera-auditor-readonly` for independent review. Model choices remain in the profiles. Workflow workers are leaves. The runner bounds the complete run, including nested workflows.

Use `access: "read"` for investigations. It denies edits and shell commands. Real command-based verification needs a suitably permitted worker with `access: "write"`, even when its intended task is only running tests. Use `isolation: "worktree"` for independent implementations and return the retained directory and changed paths. Give subsequent verification the same directory. The root owns integration.

Verification evidence is part of the handoff. `FAIL` and `INCONCLUSIVE` cannot establish a passing step. Do not replace execution evidence with reviewer votes. A workflow does not expand the user's authorization for external actions.

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

Invoke with structured arguments, for example `args: { modules: ["src/auth", "src/billing"], check: "missing authorization checks" }`. Set `maxAgents` to cover the named slices and any verification steps. Built-in defaults are four total agents and three concurrent agents; plugin options can override them. The `workflows_start` schema shows the configured defaults.

The example returns candidate findings. Add an independent confirmation stage when the task requires a verified report.
