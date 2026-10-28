import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { workflowEngine } from "../src/workflow-engine";
import { WorkflowRun } from "../src/workflow-types";

function run(id: string, ownerID: string, fields: Partial<WorkflowRun> = {}) {
  return WorkflowRun.parse({
    version: 1, id, key: id, ownerID, callerAgent: "build", model: { providerID: "fixture", id: "fixture" },
    projectID: "project", directory: "/fixture", name: id, description: id, script: "return null", args: null,
    fingerprint: id, limits: {}, status: "paused", created: 1, updated: 1, phase: "", steps: [], logs: [], checkpoints: [],
    deliveryID: `msg_${id.padEnd(32, "0")}`, delivered: false, ...fields,
  });
}

// The host decodes every workflows/runs/ value a get or scan returns; these counts track that work.
function fixture(records: WorkflowRun[]) {
  const values = new Map<string, unknown>(records.map((record) => [`workflows/runs/${record.id}`, structuredClone(record)]));
  const stats = { runScans: 0, runDecodes: 0 };
  const isRun = (key: string) => key.startsWith("workflows/runs/");
  const storage = {
    async get(key: string) {
      const value = structuredClone(values.get(key));
      if (isRun(key) && value !== undefined) stats.runDecodes++;
      return value;
    },
    async set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async remove(key: string) { values.delete(key); },
    async scan(input: { prefix: string; after?: string; limit?: number }) {
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after)).sort();
      const selected = keys.slice(0, input.limit ?? 100);
      if (input.prefix.startsWith("workflows/runs/")) stats.runScans++;
      stats.runDecodes += selected.filter(isRun).length;
      return { entries: selected.map((key) => ({ key, value: structuredClone(values.get(key)) })), next: keys.length > selected.length ? selected.at(-1) : undefined };
    },
  };
  const delivered: string[] = [];
  const ctx = {
    storage,
    session: {
      async synthetic(input: { id: string; sessionID: string }) { delivered.push(`${input.sessionID}:${input.id}`); return { id: input.id }; },
      async get({ sessionID }: { sessionID: string }) { throw { _tag: "Session.NotFoundError", sessionID }; },
    },
  } as unknown as Plugin.Context;
  const engine = workflowEngine(ctx, {} as Parameters<typeof workflowEngine>[1]);
  return { engine, stats, values, delivered, reset: () => Object.assign(stats, { runScans: 0, runDecodes: 0 }) };
}

test("a snapshot list reads each of the owner's journals once and never another owner's", async () => {
  const others = Array.from({ length: 150 }, (_, index) => run(`other-${index}`, "owner-b", { status: "completed", delivered: true }));
  const mine = [run("mine-paused", "owner-a"), run("mine-done", "owner-a", { status: "completed", delivered: true, created: 2 })];
  const h = fixture([...others, ...mine]);

  expect((await h.engine.list("owner-a")).map((item) => item.id)).toEqual(["mine-done", "mine-paused"]);
  h.reset();
  for (let index = 0; index < 10; index++) await h.engine.list("owner-a");
  // 0.3.4 decoded every owner's journal three times per list here: 60 scans and 4,580 decodes.
  expect(h.stats).toEqual({ runScans: 0, runDecodes: 10 * mine.length });
  await h.engine.dispose();
});

test("list returns runs as recovery and delivery left them", async () => {
  const h = fixture([
    run("stopping", "owner-a", { status: "stopping", created: 3 }),
    run("finished", "owner-a", { status: "completed", created: 2 }),
    run("paused", "owner-a", { created: 1 }),
    run("foreign", "owner-b", { status: "running" }),
  ]);
  const listed = await h.engine.list("owner-a");
  expect(listed.map((item) => [item.id, item.status, item.delivered])).toEqual([
    ["stopping", "stopped", true],
    ["finished", "completed", true],
    ["paused", "paused", false],
  ]);
  // Recovery is per owner: owner-b's active run is untouched until owner-b lists.
  expect((h.values.get("workflows/runs/foreign") as WorkflowRun).status).toBe("running");
  expect(h.delivered.every((entry) => entry.startsWith("owner-a:"))).toBe(true);
  expect(h.delivered).toHaveLength(2);

  // A later write is visible to the next list.
  const paused = h.values.get("workflows/runs/paused") as WorkflowRun;
  h.values.set("workflows/runs/paused", { ...paused, phase: "Edited elsewhere" });
  expect((await h.engine.list("owner-a")).find((item) => item.id === "paused")?.phase).toBe("Edited elsewhere");
  expect(h.delivered).toHaveLength(2);
  await h.engine.dispose();
});
