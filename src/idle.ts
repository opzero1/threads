import type { z } from "zod";
import type { WorkerView } from "./rpc";

type Status = "idle" | "running";

// A native tab makes OpenCode load the session's Location and keep revalidating it,
// so a managed worker gets an automatic tab only while it works.
export function workerWorking(
  worker: Pick<z.infer<typeof WorkerView>, "outcome" | "report">,
  status: Status,
) {
  return status === "running" || (worker.outcome === null && worker.report === null);
}

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
