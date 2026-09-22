# Run a dynamic workflow

Describe the work with `/workflow-run`. OpenCode loads the authoring contract, writes a JavaScript script, and starts the run in the background.

```text
/workflow-run Audit src/auth and src/billing for missing authorization checks. Use VERA reviewers, confirm each finding independently, and return source references.
```

The run has a stable ID. Your conversation stays available while its agents work. Each worker uses a native OpenCode session with its selected profile, model, and permissions.

## Inspect progress

1. Run `/workflows`.
2. Select a run to open its panel.
3. Click a step to open its native worker conversation.

The panel shows phases, step outcomes, verdicts, evidence, retained directories, recorded usage, and the final result. Press `f` for the full-screen view or `Esc` to close the panel.

Ask the agent to inspect the run when you need its complete saved script or structured handoffs:

```text
Inspect that workflow and summarize the confirmed findings and missing evidence.
```

## Pause, stop, and resume

Press `p` in the run panel to pause new scheduling. Active steps finish before the run becomes paused.

Press `x` to stop the run and interrupt its active workers. Completed results and worktree directories remain available.

Press `r` to resume. For a waiting checkpoint, enter a JSON response. For example, enter `true`, `42`, or a quoted string.

After a service restart, reopen the original conversation and select the run with `/workflows`. Resume reconciles its existing sessions before scheduling more work. It does not assume that an interrupted write left the directory unchanged.

## Save a useful workflow

1. Select its run in `/workflows`.
2. Press `s`.
3. Enter a new name.
4. Select **Project** or **User**.

The saved file contains the script. Run arguments and worker conversations stay in the original run. Existing files are not overwritten.

Invoke `/workflow-<name>` to reuse the script with new input. Project scripts live in `.opencode/workflows/`. Personal scripts live in the `workflows/` directory under your OpenCode configuration.

An edited script starts a new run. A run's script and arguments remain fixed so resuming it cannot silently reuse results from different instructions.

## Use VERA roles

Ask for VERA when the task needs its engineering and evidence rules. The workflow chooses configured role IDs such as `vera-engineer` and `vera-auditor-readonly`; `/setup-vera` remains the place to change their models.

Keep an implementation and its runtime verification on the same retained worktree. Give the auditor the changed paths and verification evidence. The root conversation inspects the artifacts and owns integration and the final verdict.

For script syntax, limits, tools, and recovery semantics, read the [runtime contract](../skills/workflow-authoring/references/runtime.md). The [implementation plan](dynamic-workflows-plan.md) describes module ownership and verification requirements.
