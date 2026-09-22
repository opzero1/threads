# Dynamic workflows implementation

## Completion criteria

An OpenCode V2 session can submit a JavaScript workflow, continue its conversation while agents run, inspect phases and worker sessions, receive validated results, pause or stop, and resume recorded work after a service restart. Writing steps can use retained worktrees. Saved workflows can run again with different arguments. VERA profiles retain their configured models and permissions. A failed or inconclusive task cannot silently become a passing workflow.

Verification covers the confined interpreter, the durable runner, actual OpenCode session and tool calls, restart recovery, and the terminal controls. A final real-model run exercises workflow authoring and structured handoffs. An independent reviewer inspects the implementation and evidence before completion.

## Baseline

- Threads: `df7686af1c6601ae7d05ae607bc584f185109231`, annotated tag `v0.1.8`, already present at `opzero1/threads`.
- Dotfiles: snapshot the current tracked setup and intended additions in `afif-reap/dotfiles` before changing VERA guidance.
- Installed OpenCode: `2.0.12`.

## Ownership

Implement workflow modules in the existing Threads package. This shares the worker service and its ownership checks without requiring an unauthenticated cross-plugin dispatch API. The `workflows` tool namespace and RPC remain distinct from the existing `threads` interface.

VERA selects the process and owns the final engineering verdict. The workflow runner schedules steps, validates handoffs, journals progress, and reconciles interrupted work. OpenCode owns model execution, permissions, tools, and worktrees. The TUI renders server state and links to native sessions.

Use the published `@opencode/codemode` package pinned to `2.0.12` for confined execution. The initial reference checkout marked its older package private; the published V2 package has a supported export. Generated scripts never run through host `eval`, `Function`, or Node `vm`.

## Protocol

1. Checkpoint the repositories and capture the existing test baseline.
2. Prove the confined script adapter with real interpreter tests: structured fan-out, per-item pipelines, deterministic inputs, cancellation, invalid scripts, and failures.
3. Implement the durable runner and worker adapter. Persist dispatch identities before starting work. Record validated results before returning them to scripts. Reconcile existing worker sessions on resume. Reject concurrent execution of the same run.
4. Integrate role authorization, structured result reporting, retained worktrees, concurrency and call limits, measured usage, saved workflows, and bounded retry helpers.
5. Add workflow tools, server commands, RPC, terminal navigation, phase and step progress, and pause, stop, resume, and checkpoint controls.
6. Add the workflow-authoring and VERA recipes. Verify actual OpenCode sessions and terminal interactions in isolated fixtures, then a scoped real-model run.
7. Inspect the complete diff, independently audit behavior and the decision trail, and resolve accepted findings.

## Recovery contract

The journal records a run, its script and arguments, each named step's request fingerprint, worker identity, execution outcome, validated result, and evidence. A restart does not blindly replay user-visible effects. Resume first reconciles an existing worker and any recorded result. An interrupted write with uncertain state requires inspection rather than an automatic fresh worker.

Script control flow uses only arguments and recorded step results. Reject clock and randomness access. Editing a run invalidates the changed call and subsequent recorded calls conservatively; named keys make the affected work identifiable. Worktree paths and results survive completion. Integration is a distinct verified action.

## Reference guidance

- [Pi Dynamic Workflows](https://github.com/QuintinShaw/pi-dynamic-workflows): code orchestration, role routing, journaling, worktrees, and interactive progress.
- [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows): structured per-item pipelines and when workflows are useful.
- [Claude Code workflows](https://code.claude.com/docs/en/workflows): deterministic scripts, replay semantics, saved commands, background controls, and validation before spawning.
- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins): supported host integration.

The references inform the behavior. Existing OpenCode and VERA ownership, permissions, and evidence requirements determine the implementation.
