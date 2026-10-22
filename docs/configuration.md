# Configuration

Threads has two parts, and each has its own config entry:

- The **server plugin** runs workers and workflows. It lives in `~/.config/opencode/opencode.json` or `opencode.jsonc`.
- The **terminal plugin** draws the footer indicator, the Threads list, the workflow panel, and the sidebar's Workflows section. It lives in `~/.config/opencode/cli.json`.

Both entries use the same package, `@op1/threads`.

## Server plugin

The smallest entry is the package name:

```jsonc
{
  "plugins": ["@op1/threads"]
}
```

To set options, use an object:

```jsonc
{
  "plugins": [
    {
      "package": "@op1/threads",
      "options": { "maxWorkers": 8, "workflowConcurrency": 8 }
    }
  ]
}
```

Keep your other plugin entries in the list.

### Server options

| Option | Default | Range | What it controls |
| --- | --- | --- | --- |
| `maxWorkers` | 4 | 1–32 | Unfinished workers per conversation. Workflow steps owned by that conversation count against the same limit. |
| `workflowConcurrency` | 3 | 1–8 | Steps that one new workflow runs at the same time. |
| `workflowMaxAgents` | Unset | 1–1,000 when supplied | Optional user-selected total-step budget for new workflows. |
| `workflowWorktreeCleanup` | `true` | `true` or `false` | Whether a workflow removes its clean step worktrees when it ends. |

A worker stops counting against `maxWorkers` when it reports, or when its run fails or is interrupted. A worker whose run ends without a report keeps its slot until you deal with it. A workflow step worker is the exception: it also frees its slot when its step fails or its workflow ends. A step whose task finishes without a `workflows_result` report fails. A follow-up to a worker that no longer counts doesn't take a slot.

Values passed to `workflows_start` override configured workflow values. Task budgets have no built-in defaults; agents leave them unset unless requested. Existing runs keep the limits they started with. A run never has more active steps than `maxWorkers` allows. To run eight steps at once, set `maxWorkers` and `workflowConcurrency` to at least 8.

With `workflowWorktreeCleanup` set to `false`, finished runs keep all their step worktrees until you run `workflows_prune`. The setting affects only runs that end while it applies. See [clean up worktrees](workflows.md#clean-up-worktrees).

### Control workflow starts

Agents start a workflow only when you ask for one, run `/workflow-run` or a saved workflow, or a loaded skill says to. Otherwise they propose the workflow and ask in the conversation.

Before it creates a run, `workflows_start` asks OpenCode to check the `workflows_start` permission for the calling agent and conversation. The resource is the saved workflow's name, or `*` for an inline script. To approve each start yourself, add an `ask` rule:

```jsonc
{
  "permissions": [{ "action": "workflows_start", "resource": "*", "effect": "ask" }]
}
```

OpenCode then shows a permission prompt for `workflows_start`, and the run starts only after you allow it once. If you reject it, no run is created. Threads saves no approval: the terminal prompt has no **Always** choice, and an **Always** reply from another client approves only that start. This is because a saved workflow can be rewritten under the same name and an inline script has no stable name. To stop being asked for one saved workflow, add an `allow` rule for its name after the `ask` rule, for example `{ "action": "workflows_start", "resource": "audit", "effect": "allow" }`.

Every call is checked, so an `ask` rule prompts again for an exact retry with the same key. A retry still returns the existing run and never starts a second one.

To turn off workflow starts, use `"effect": "deny"` instead. Agents then don't see `workflows_start`. Remove the rule to allow workflows again.

An agent with no matching rule gets OpenCode's default, `ask`. OpenCode's default agents allow everything, so they see no prompt unless you add a rule.

## Terminal plugin

```json
{
  "plugins": [{ "package": "@op1/threads" }]
}
```

The terminal plugin takes no options. Server options don't reach it.

## Pin a version

Add the version to the package name in both files, for example `@op1/threads@0.3.2`.

## Use a local checkout

1. Clone the repository and run `bun install`.
2. In both files, replace `@op1/threads` with the absolute path of the clone.
3. Restart OpenCode.

Local and published installs share the plugin ID `op-threads`, so switching between them keeps your worker records.

## Commands

| Command | Action |
| --- | --- |
| `/activities` or `ctrl+x j` | Open the Threads list for the current conversation. |
| `/threads` | Bring back hidden and dismissed workers, then open the Threads list. |
| `/workflow-run <task>` | Ask the agent to write and start a workflow. |
| `/workflows` | Open the workflow navigator. |

`ctrl+x` is OpenCode's default leader key, so the list shortcut is `<leader>j`.

## Shortcuts

In the Threads list:

| Key | Action | Command ID |
| --- | --- | --- |
| Type | Search | |
| **Up**, **Down**, **Ctrl+P**, **Ctrl+N** | Move the highlight | |
| **Enter** | Show the row's menu: **Open**, and **Dismiss** or **Restore** for a closed row | |
| **Esc** | Close the list | |

In the workflow panel:

| Key | Action | Command ID |
| --- | --- | --- |
| **Up**, **Down** | Select a step | `workflows.previous-step`, `workflows.next-step` |
| **Enter** | Open the step's worker | `workflows.open-step` |
| `p` | Pause | `workflows.pause` |
| `r` | Resume | `workflows.resume` |
| `x` | Stop | `workflows.stop` |
| `s` | Save the script | `workflows.save` |
| `f` | Toggle full screen | `workflows.fullscreen` |
| **Esc** | Close the panel | `workflows.close` |

To change a shortcut, set its command ID under `keybinds` in `cli.json`. The list's own ID is `threads.activity.choose`:

```json
{
  "keybinds": { "threads.activity.choose": "<leader>t" }
}
```

## Skills

The plugin loads the `workflow-authoring` skill by itself. `/workflow-run` uses it.

The `managed-sessions` skill is optional. To use it, copy [`skills/managed-sessions`](../skills/managed-sessions) into `~/.config/opencode/skills/`.
