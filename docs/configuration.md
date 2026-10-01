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
      "options": { "maxWorkers": 8, "workflowConcurrency": 8, "workflowMaxAgents": 8 }
    }
  ]
}
```

Keep your other plugin entries in the list.

### Server options

| Option | Default | Range | What it limits |
| --- | --- | --- | --- |
| `maxWorkers` | 4 | 1–32 | Unfinished workers per conversation. Workflow steps owned by that conversation count against the same limit. |
| `workflowConcurrency` | 3 | 1–8 | Steps that one new workflow runs at the same time. |
| `workflowMaxAgents` | 4 | 1–1,000 | Total agent steps in one new workflow. |

A worker stops counting against `maxWorkers` when it reports, or when its run fails or is interrupted. A worker whose run ends without a report keeps its slot until you deal with it.

Values passed to `workflows_start` override the workflow defaults. Existing runs keep the limits they started with. A run never has more active steps than `maxWorkers` allows. To run eight steps at once, set all three options to at least 8.

## Terminal plugin

```json
{
  "plugins": [{ "package": "@op1/threads" }]
}
```

The terminal plugin takes no options. Server options don't reach it.

## Pin a version

Add the version to the package name in both files, for example `@op1/threads@0.2.8`.

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
| `/workflow-<name>` | Run a saved workflow with new input. |
| `/workflow-refresh` | Reload saved workflow commands after you edit their files. |

`ctrl+x` is OpenCode's default leader key, so the list shortcut is `<leader>j`.

## Shortcuts

In the Threads list:

| Key | Action | Command ID |
| --- | --- | --- |
| Type | Search | |
| **Up**, **Down**, **Ctrl+P**, **Ctrl+N** | Move the highlight | |
| **Enter** | Open the highlighted conversation | |
| **Ctrl+D** | Dismiss the row, or bring a closed row back | `threads.activity.choose.dismiss` |
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
