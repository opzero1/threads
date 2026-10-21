import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { serialized } from "./threads";
import { Json, WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES, WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES, WorkflowRun } from "./workflow-types";

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

export function workflowStore(storage: Plugin.Context["storage"], options: {
  onDiagnostic?: (issue: { id: string; ownerID: string; message: string }) => Promise<void>;
} = {}) {
  const journalLimit = 16 * 1024 * 1024;
  const controlHeadroom = (run: WorkflowRun) => {
    const settled = new Set(run.settlements?.filter((item) => item.kind === "agent").map((item) => item.key));
    const pending = run.steps.reduce((bytes, step) => {
      if (step.status === "completed") return bytes;
      const settlementBytes = settled.has(step.key) ? 0
        : Buffer.byteLength(JSON.stringify({ kind: "agent", key: step.key, outcome: "failure", error: "" }), "utf8")
          + WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES + 1;
      return bytes + settlementBytes + (step.status === "failed" ? 0 : WORKFLOW_DIAGNOSTIC_JSON_BYTES + 256);
    }, 0);
    return Math.max(WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES + 256 + pending);
  };
  const key = (id: string) => `workflows/runs/${id}`;
  // Each checkpoint answer is stored once, in settlement order. Readers see it on the checkpoint.
  const answered = (run: WorkflowRun) => {
    for (const entry of run.settlements ?? []) {
      if (entry.kind !== "checkpoint") continue;
      const checkpoint = run.checkpoints.find((item) => item.key === entry.key);
      if (checkpoint) checkpoint.response = entry.response;
    }
    return run;
  };
  async function persist(run: WorkflowRun, kind: "payload" | "control") {
    const settled = new Set(run.settlements?.flatMap((item) => item.kind === "checkpoint" ? [item.key] : []));
    const value = structuredClone(Json.parse({
      ...run,
      checkpoints: run.checkpoints.map(({ response, ...checkpoint }) => settled.has(checkpoint.key) || response === undefined ? checkpoint : { ...checkpoint, response }),
    }));
    const limit = journalLimit - (kind === "payload" ? controlHeadroom(run) : 0);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit) {
      if (kind === "payload") {
        throw new Error("Workflow payload exceeds 16 MiB journal capacity after required control headroom is reserved");
      }
      throw new Error("Workflow control update exceeds the 16 MiB journal hard limit and cannot be persisted without discarding durable data");
    }
    await storage.set(key(run.id), value);
  }
  async function get(id: string) {
    const raw = await storage.get(key(id));
    if (raw === undefined) throw new Error(`Workflow ${id} not found`);
    const parsed = WorkflowRun.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Workflow ${id} has a corrupt or unsupported journal record; its raw data was preserved at ${key(id)}: ${parsed.error.issues[0]?.message ?? "validation failed"}. Inspect the retained record or start a new workflow run key.`);
    }
    return answered(parsed.data);
  }
  return {
    get,
    async create(run: WorkflowRun) {
      return serialized(`workflow-store:${run.id}`, async () => {
        const existing = await storage.get(key(run.id));
        if (existing !== undefined) {
          const previous = await get(run.id);
          if (previous.fingerprint !== run.fingerprint) throw new Error("This workflow key belongs to a different request");
          return previous;
        }
        await persist(run, "payload");
        return run;
      });
    },
    async update(id: string, update: (run: WorkflowRun) => void, kind: "payload" | "control" = "payload") {
      return serialized(`workflow-store:${id}`, async () => {
        const run = await get(id);
        update(run);
        answered(run);
        run.updated = Date.now();
        const next = WorkflowRun.parse(run);
        await persist(next, kind);
        return next;
      });
    },
    async list(ownerID: string) {
      const runs: WorkflowRun[] = [];
      let after: string | undefined;
      do {
        const page = await storage.scan({ prefix: "workflows/runs/", after, limit: 100 });
        for (const entry of page.entries) {
          const raw = entry.value;
          if (typeof raw !== "object" || raw === null || !("ownerID" in raw) || raw.ownerID !== ownerID) continue;
          const parsed = WorkflowRun.safeParse(raw);
          if (parsed.success) runs.push(answered(parsed.data));
          else await options.onDiagnostic?.({
            id: entry.key.slice("workflows/runs/".length), ownerID,
            message: `Corrupt or unsupported journal record: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
          }).catch(() => undefined);
        }
        after = page.next;
      } while (after);
      return runs.sort((a, b) => b.created - a.created);
    },
    // Every owner's readable runs that `include` selects before parsing. Corrupt records are
    // reported through their owner's list.
    async all(include: (raw: { status?: unknown; projectID?: unknown; updated?: unknown }) => boolean = () => true) {
      const runs: WorkflowRun[] = [];
      let after: string | undefined;
      do {
        const page = await storage.scan({ prefix: "workflows/runs/", after, limit: 100 });
        for (const entry of page.entries) {
          const raw = entry.value;
          if (typeof raw !== "object" || raw === null || !include(raw as { status?: unknown; projectID?: unknown; updated?: unknown })) continue;
          const parsed = WorkflowRun.safeParse(raw);
          if (parsed.success) runs.push(answered(parsed.data));
        }
        after = page.next;
      } while (after);
      return runs.sort((a, b) => b.created - a.created);
    },
  };
}
