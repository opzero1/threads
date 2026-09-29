# Changelog

## Unreleased

- Rewrote the README and split the docs into guides, configuration, reference, and design pages.

## 0.2.6

- The Threads list shows only the current conversation and its workers.
- The footer counts the same workers as the list, including in a worker's tab.
- Removed the Activity sidebar, pins, automatic worker tabs, native tab reordering, and saved-title cleanup. The `activity` and `workerTabs` terminal options are ignored.

## 0.2.5

Release candidate, not published to npm. Its changes shipped in 0.2.6.

- The footer indicator and the Threads list replaced the sidebar as the default view.
- `paths` lets workers and workflow steps use folders outside their directory without asking.
- Idle terminals no longer wake idle OpenCode Locations.

## 0.2.4

- Workflow workers recover from assistant prefill failures.

## 0.2.3

- Workflow worktrees work across nested projects.

## 0.2.2

- The npm package ships a precompiled terminal UI. This fixes the `Cannot find package 'react'` error in 0.2.0 and 0.2.1.

## 0.2.1

- Included the JSX configuration in the package. This did not fix loading from `node_modules`. Use 0.2.2 or later.

## 0.2.0

- Added dynamic workflows: `/workflow-run`, `/workflows`, saved scripts, checkpoints, retained worktrees, and restart recovery.
- Added the `workflowConcurrency` and `workflowMaxAgents` options.

## 0.1.8

- Last release before workflows.

## 0.1.7

- Compatibility with OpenCode 2.0.7.

## 0.1.6

- Added `agent` to start workers with a configured profile.

## 0.1.3

- Workers that pass hide by themselves. Reports reach the coordinator silently.

## 0.1.0

- First release: managed top-level worker sessions with durable reports.
