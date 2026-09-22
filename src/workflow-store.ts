import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { serialized } from "./threads";
import { Json, WorkflowRun } from "./workflow-types";

export function workflowHash(value: unknown): string {
  const json = Json.parse(value);
  const canonical = (item: Json): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(json)).digest("hex");
}

export function workflowStore(storage: Plugin.Context["storage"]) {
  const key = (id: string) => `workflows/runs/${id}`;
  async function get(id: string) {
    const raw = await storage.get(key(id));
    if (raw === undefined) throw new Error(`Workflow ${id} not found`);
    return WorkflowRun.parse(raw);
  }
  return {
    get,
    async create(run: WorkflowRun) {
      return serialized(`workflow-store:${run.id}`, async () => {
        const existing = await storage.get(key(run.id));
        if (existing !== undefined) {
          const previous = WorkflowRun.parse(existing);
          if (previous.fingerprint !== run.fingerprint) throw new Error("This workflow key belongs to a different request");
          return previous;
        }
        await storage.set(key(run.id), Json.parse(run));
        return run;
      });
    },
    async update(id: string, update: (run: WorkflowRun) => void) {
      return serialized(`workflow-store:${id}`, async () => {
        const run = await get(id);
        update(run);
        run.updated = Date.now();
        const next = WorkflowRun.parse(run);
        await storage.set(key(id), Json.parse(next));
        return next;
      });
    },
    async list(ownerID: string) {
      const runs: WorkflowRun[] = [];
      let after: string | undefined;
      do {
        const page = await storage.scan({ prefix: "workflows/runs/", after, limit: 100 });
        for (const entry of page.entries) {
          const run = WorkflowRun.parse(entry.value);
          if (run.ownerID === ownerID) runs.push(run);
        }
        after = page.next;
      } while (after);
      return runs.sort((a, b) => b.created - a.created);
    },
  };
}
