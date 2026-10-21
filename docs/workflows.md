# Run a dynamic workflow

Describe the work with `/workflow-run`. OpenCode loads the authoring contract, writes a JavaScript script, and starts the run in the background.

```text
/workflow-run Audit src/auth and src/billing for missing authorization checks. Use VERA reviewers, confirm each finding independently, and return source references.
```

The run has a stable ID. Your conversation stays available while its agents work. Each worker uses a native OpenCode session with its selected profile, model, and permissions.

## Inspect progress

1. Run `/workflows`.
2. Select a run to open its panel.
3. Select a step with the arrow keys and press **Enter**, or click it, to open its native worker conversation.

You can also open a run's panel from these places:

- **The prompt footer.** While workflows run, the footer shows a count such as `1 workflow`. Click it to open that run's panel. When several runs are active, the click opens the `/workflows` list.
- **The sidebar.** The **Workflows** section lists up to five unfinished runs with their status and step count, such as `running · 1/3 steps`. Click a row to open its panel. Finished runs appear only in `/workflows`. Press `ctrl+x b` to show or hide the sidebar. The panel takes the sidebar's place. On a narrow terminal, press `ctrl+x b` again after you close the panel to bring the sidebar back.

The panel shows phases, step outcomes, verdicts, evidence, retained directories, recorded usage, and the final result. Step counts include work recorded so far; a dynamic script can add more steps. Press `f` for the full-screen view or `Esc` to close the panel.

The navigator lists every run owned by the current coordinator session, including completed and failed runs. The detail panel shows one selected run. Other coordinator sessions have their own run lists.

A worker that needs a directory outside its location can ask for your approval in its own conversation. The footer and the Threads list mark it as needing input, and the step waits for your answer. To avoid the prompt, name the directories the task needs in your request; the workflow grants them to a step with `paths`. Explicit denies in your configuration still apply.

Ask the agent to inspect the run when you need its complete saved script or structured handoffs:

```text
Inspect that workflow and summarize the confirmed findings and missing evidence.
```

## Pause, stop, and resume

Press `p` in the run panel to pause new scheduling. Active steps finish before the run becomes paused.

Press `x` to stop the run and interrupt its active workers. Completed results remain available. A stopped run can't be resumed, so Threads then [cleans up its worktrees](#clean-up-worktrees).

Press `r` to resume. For a waiting checkpoint, enter a JSON response. For example, enter `true`, `42`, or a quoted string.

Checkpoint and interruption notices reach the coordinator conversation with the run ID and the next control action. Inspect the run before responding or resuming.

After a service restart, reopen the original conversation and select the run with `/workflows`. Resume reconciles its existing sessions before scheduling more work. It does not assume that an interrupted write left the directory unchanged.

If a worker shows **Session failed** with a blocked-generation error, inspect the run, step, and worker named in that error. Follow the same recovery procedure after a plugin reload. A restart notice alone does not authorize the worker to continue.

For an uncertain write, ask the agent to inspect the retained worker and directory. Send the resolution request to that same worker. After the worker reports and finishes, resume the run. Use the [recovery contract](../skills/workflow-authoring/references/runtime.md#start-and-control) for crash and legacy-journal limits.

## Clean up worktrees

A step with `isolation: "worktree"` works in its own git checkout under `.opencode-workflows/`, next to its source directory. OpenCode creates the checkout on a detached `HEAD`, without a branch.

When a run ends, Threads removes each of its step checkouts that would lose nothing:

- The checkout has no uncommitted or untracked changes. Ignored files, such as `node_modules`, don't count and are removed with it.
- Every commit at its `HEAD` is also on a branch, a tag, or a remote branch.

A run ends when it is `completed`, `failed`, or `stopped`. These runs can't be resumed. A run that is `running`, `pausing`, `waiting`, `paused`, `stopping`, or `interrupted` keeps its checkouts, because it still uses them or can resume in them. Resume doesn't restore a removed checkout: it would create a fresh one from the source's current `HEAD`.

Threads removes a checkout through OpenCode, which runs `git worktree remove` without `--force`. Branches, commits, run records, and worker conversations stay. Shared steps run in their source directory, which Threads never removes. A checkout is also kept while it contains another worktree, while an unfinished run uses it as a step directory, while a worker located in it is running, and while the run's owning conversation is located in it. Threads can't see where other conversations are located, so it can remove a clean checkout that another conversation is still in.

A workflow step can't start in a checkout while Threads removes it. If the checkout is gone by the time the step is recorded, the step fails with an error that says the directory no longer exists. A follow-up you send to a worker in that checkout waits until the removal finishes.

Cleanup runs once, in the background, when the run's final status and result are recorded, so it can't delay or change them or the completion notice. Ask the agent to inspect the run to see what happened. Its `worktreeCleanup` lists each checkout as `removed`, `missing` (already gone), or `kept` with a reason:

| Reason | Meaning |
| --- | --- |
| `changes` | The checkout has uncommitted or untracked changes. |
| `commits` | `HEAD` has commits that no branch, tag, or remote contains. To keep them, create a branch in the checkout, then prune. |
| `nested` | Another worktree is inside the checkout. Removing the checkout would delete it, even when git ignores it. |
| `in-use` | An unfinished run uses the directory, a worker in it is still running, or the owning or calling conversation is located in it. |
| `unregistered` | No known project lists the directory as a worktree. |
| `error` | Inspection, the check for a running worker, or removal failed, or cleanup stopped first. `message` says why. |

To keep a writer's work for integration after the run, ask it to commit to a named branch or to leave its changes uncommitted.

If OpenCode stops before cleanup finishes, Threads doesn't resume it. Run `workflows_prune` to remove what it left. If you send a follow-up to a finished run's worker, its checkout may already be gone.

To turn automatic cleanup off, set [`workflowWorktreeCleanup`](configuration.md#server-options) to `false`. The setting applies to runs that end while it's on. Runs that ended earlier, or while it was off, are left for `workflows_prune`.

### Prune leftover worktrees

Ask the agent to list what's left:

```text
Run workflows_prune and show me which worktrees it would remove.
```

`workflows_prune` changes nothing by default. It lists the step checkouts of finished runs that still exist, with the same rules and reasons as automatic cleanup. It also lists checkouts of unfinished runs as kept with reason `unfinished`. To make those removable, stop the run from its owning conversation.

To remove the clean checkouts, ask the agent to call it again with `apply: true`. Prune records what it removed and kept on each run. It doesn't delete run records, sessions, or branches. Add `olderThanDays` to limit it to runs that ended at least that many days ago.

Prune covers every finished run in the current conversation's project, whichever conversation owns it. Only a run's owner can control it while it can still change. A finished run can't change, and prune removes only checkouts that lose nothing, so it doesn't need that ownership check. This lets you clean up runs from conversations you no longer have open. Only a top-level conversation can prune, and agents that can't edit files don't get the tool.

## Save a useful workflow

1. Select its run in `/workflows`.
2. Press `s`.
3. Enter a new name.
4. Select **Project** or **User**.

The saved file contains the script. Run arguments and worker conversations stay in the original run. Existing files are not overwritten; the `workflows_save` tool replaces one only with `overwrite: true`.

To reuse a script with new input, ask the agent to run the saved workflow by name. It finds it with `workflows_saved` and starts it with `workflows_start`. Project scripts live in `.opencode/workflows/`. Personal scripts live in the `workflows/` directory under your OpenCode configuration.

An edited script starts a new run. A run's script and arguments remain fixed so resuming it cannot silently reuse results from different instructions.

Add an optional `whenToUse` string to `meta` to help the agent choose between saved workflows.

## Use VERA roles

Ask for VERA when the task needs its engineering and evidence rules. The workflow chooses configured role IDs such as `vera-engineer` and `vera-auditor-readonly`; `/setup-vera` remains the place to change their models.

Keep an implementation and its runtime verification on the same retained worktree. Give the auditor the changed paths and verification evidence. The root conversation inspects the artifacts and owns integration and the final verdict.

## Go further

- For script syntax, limits, tools, and recovery rules, read the [runtime contract](../skills/workflow-authoring/references/runtime.md).
- To change default limits, see [server options](configuration.md#server-options).
- For measured throughput and safe operating limits, see [capacity findings](workflow-capacity-findings.md).
