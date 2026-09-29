type Status = "idle" | "running";

export function workInProgress(
  tabs: readonly { readonly busy: boolean; readonly attention: boolean }[],
  sessionIDs: Iterable<string>,
  status: (sessionID: string) => Status,
) {
  if (tabs.some((tab) => tab.busy || tab.attention)) return true;
  for (const sessionID of sessionIDs) if (status(sessionID) === "running") return true;
  return false;
}

export function workflowProgressing(statuses: Iterable<string>) {
  for (const status of statuses)
    if (status === "running" || status === "pausing" || status === "waiting") return true;
  return false;
}
