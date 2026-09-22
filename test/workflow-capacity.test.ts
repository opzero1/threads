import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { withWorkflowSlot } from "../src/workflow-worker";
import { workflowStore } from "../src/workflow-store";
import { WorkflowLimits, WorkflowRun } from "../src/workflow-types";

test("public workflow limits accept their exact ceilings and reject one beyond", () => {
  expect(WorkflowLimits.parse({ concurrency: 8, maxAgents: 1000, agentTimeoutMs: 604_800_000, timeoutMs: 604_800_000 }))
    .toMatchObject({ concurrency: 8, maxAgents: 1000 });
  expect(() => WorkflowLimits.parse({ concurrency: 9 })).toThrow();
  expect(() => WorkflowLimits.parse({ maxAgents: 1001 })).toThrow();
  expect(() => WorkflowLimits.parse({ agentTimeoutMs: 604_800_001 })).toThrow();
  expect(() => WorkflowLimits.parse({ timeoutMs: 604_800_001 })).toThrow();
});

test("owner and run semaphores cap at eight and abort queued work without leaking permits", async () => {
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tasks = Array.from({ length: 16 }, (_, index) => withWorkflowSlot(
    "capacity-owner", 8, `run-${index % 2}`, 8, controller.signal,
    async () => { active++; peak = Math.max(peak, active); await blocked; active--; },
  ));
  while (active < 8) await Bun.sleep(1);
  expect(peak).toBe(8);
  controller.abort(new Error("capacity cancellation"));
  release();
  const results = await Promise.allSettled(tasks);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(8);
  expect(results.filter((item) => item.status === "rejected")).toHaveLength(8);
  expect(active).toBe(0);
  await expect(withWorkflowSlot("capacity-owner", 8, "fresh", 8, new AbortController().signal, async () => "ok"))
    .resolves.toBe("ok");
});

test("durable run journal rejects content beyond 16 MiB without replacing prior evidence", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async remove(key: string) { values.delete(key); },
    async scan() { return { entries: [], next: undefined }; },
  } as unknown as Plugin.Context["storage"];
  const store = workflowStore(storage);
  const run = WorkflowRun.parse({
    version: 1, id: "capacity", key: "capacity", ownerID: "owner", callerAgent: "caller",
    model: { providerID: "fixture", id: "fixture" }, projectID: "project", directory: "/fixture",
    name: "capacity", description: "capacity", script: "return null", args: null,
    fingerprint: "fingerprint", limits: {}, status: "paused", created: 1, updated: 1,
    phase: "", steps: [], logs: [], checkpoints: [], deliveryID: "delivery", delivered: false,
  });
  await store.create(run);
  await expect(store.update(run.id, (draft) => { draft.result = "x".repeat(17 * 1024 * 1024); }))
    .rejects.toThrow("exceeds 16 MiB");
  expect((await store.get(run.id)).result).toBeUndefined();
});
