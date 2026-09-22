import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { workflowHash, workflowStore } from "../src/workflow-store";
import { Json, WORKFLOW_CONTROL_HEADROOM, WorkflowRun, workflowSummary } from "../src/workflow-types";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function disk() {
  await mkdir(join(import.meta.dir, "../.audit"), { recursive: true });
  const directory = await mkdtemp(join(import.meta.dir, "../.audit/journal-"));
  temporary.push(directory);
  const path = (key: string) => join(directory, encodeURIComponent(key));
  const storage: Plugin.Context["storage"] = {
    async get(key) {
      try {
        return Json.parse(JSON.parse(await readFile(path(key), "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async set(key, value) {
      await writeFile(`${path(key)}.tmp`, JSON.stringify(value));
      await rename(`${path(key)}.tmp`, path(key));
    },
    async remove(key) { await rm(path(key), { force: true }); },
    async scan({ prefix, after, limit }) {
      const keys = (await readdir(directory)).map(decodeURIComponent).filter((key) => key.startsWith(prefix) && (!after || key > after)).sort();
      const selected = keys.slice(0, limit);
      return {
        entries: await Promise.all(selected.map(async (key) => ({ key, value: Json.parse(await this.get(key)) }))),
        ...(keys.length > selected.length ? { next: selected.at(-1) } : {}),
      };
    },
  };
  return { storage, directory, path };
}

function run(id = "workflow-a", ownerID = "owner-a") {
  return WorkflowRun.parse({
    version: 1, id, key: "task", ownerID, callerAgent: "build", model: { providerID: "fixture", id: "fixture" },
    projectID: "project", directory: "/fixture", name: "audit", description: "Audit", script: "script", args: null,
    fingerprint: "fingerprint", limits: {}, status: "paused", created: 1, updated: 1, phase: "", steps: [], logs: [], checkpoints: [],
    deliveryID: "delivery-a", delivered: false,
  });
}

test("run records survive reopening storage and exact admission rejects conflicting reuse", async () => {
  const fixture = await disk();
  const first = workflowStore(fixture.storage);
  await first.create(run());
  await first.update("workflow-a", (draft) => { draft.phase = "Review"; });
  const reopened = workflowStore(fixture.storage);
  expect((await reopened.get("workflow-a")).phase).toBe("Review");
  expect((await reopened.create(run())).phase).toBe("Review");
  await expect(reopened.create({ ...run(), fingerprint: "different" })).rejects.toThrow("different request");
  expect((await reopened.get("workflow-a")).fingerprint).toBe("fingerprint");
});

test("concurrent run updates retain every write and listings are owner scoped", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  await store.create(run());
  await store.create(run("workflow-b", "owner-b"));
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.update("workflow-a", (draft) => {
    draft.logs.push({ time: index, text: `step ${index}` });
  })));
  expect((await store.get("workflow-a")).logs).toHaveLength(30);
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["workflow-a"]);
});

test("corrupt or unknown journal versions fail without replacing evidence", async () => {
  const fixture = await disk();
  const path = fixture.path("workflows/runs/workflow-a");
  await writeFile(path, JSON.stringify({ ...run(), version: 99 }));
  await expect(workflowStore(fixture.storage).get("workflow-a")).rejects.toThrow("raw data was preserved");
  expect(JSON.parse(await readFile(path, "utf8")).version).toBe(99);
});

test("list skips a corrupt sibling without hiding healthy runs or replacing evidence", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  await store.create(run("healthy"));
  const corruptPath = fixture.path("workflows/runs/corrupt");
  const corrupt = { ...run("corrupt"), version: 99, evidence: "retain me" };
  await writeFile(corruptPath, JSON.stringify(corrupt));

  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["healthy"]);
  await expect(store.get("corrupt")).rejects.toThrow("corrupt or unsupported journal record");
  expect(JSON.parse(await readFile(corruptPath, "utf8"))).toEqual(corrupt);
});

test("fingerprints are independent of object insertion order and preserve array order", () => {
  expect(workflowHash({ b: 2, a: { z: 1, y: 2 } })).toBe(workflowHash({ a: { y: 2, z: 1 }, b: 2 }));
  expect(workflowHash(["a", "b"])).not.toBe(workflowHash(["b", "a"]));
});

test("run summaries exclude embedded settlement payloads", () => {
  const record = run();
  record.settlements = [{ kind: "checkpoint", key: "answer", response: "x".repeat(100_000) }];
  const summary = workflowSummary(record);
  expect("settlements" in summary).toBe(false);
  expect(summary.counts.total).toBe(0);
});

test("payload updates preserve control headroom at the journal boundary", async () => {
  const fixture = await disk();
  const limit = 16 * 1024 * 1024;
  const store = workflowStore(fixture.storage);
  const initial = run();
  initial.status = "running";
  await store.create(initial);
  await store.update("workflow-a", (current) => { current.args = "x".repeat(limit - 128 * 1024); });
  const admitted = await readFile(fixture.path("workflows/runs/workflow-a"), "utf8");
  const fill = limit - Buffer.byteLength(admitted);

  let payloadError: unknown;
  try {
    await store.update("workflow-a", (current) => { current.args = `${current.args}${"x".repeat(fill)}`; });
  } catch (error) {
    payloadError = error;
  }
  let controlError: unknown;
  try {
    await store.update("workflow-a", (current) => {
      current.status = "stopping";
      current.error = "e".repeat(20_000);
    }, "control");
  } catch (error) {
    controlError = error;
  }

  expect(payloadError).toBeInstanceOf(Error);
  expect((payloadError as Error).message).toContain("headroom");
  expect(controlError).toBeUndefined();
  expect((await store.get("workflow-a")).status).toBe("stopping");
  expect((await store.get("workflow-a")).error).toHaveLength(20_000);
});

test("legacy hard-boundary records remain readable and impossible growth fails closed", async () => {
  const fixture = await disk();
  const limit = 16 * 1024 * 1024;
  const boundary = Json.parse(run()) as Record<string, Json>;
  boundary.status = "running";
  boundary.limits = {};
  boundary.args = "x".repeat(limit - Buffer.byteLength(JSON.stringify(boundary)) + 2);
  expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(limit);
  await fixture.storage.set("workflows/runs/workflow-a", boundary);

  const store = workflowStore(fixture.storage);
  expect((await store.get("workflow-a")).args).toBe(boundary.args);
  await expect(store.update("workflow-a", (current) => {
    current.status = "stopping";
    current.error = "cannot fit";
  }, "control")).rejects.toThrow("without discarding durable data");
  expect((await store.get("workflow-a")).status).toBe("running");
});

test("payload admission reserves diagnostics for queued steps as well as active workers", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  const initial = run();
  initial.limits.maxAgents = 32;
  initial.steps = Array.from({ length: 32 }, (_, index) => ({
    status: "prepared", key: `step-${index}`, fingerprint: "input", index,
    input: { key: `step-${index}`, prompt: "read", agent: "analyst", access: "read", isolation: "shared" },
    workerID: `worker-${index}`, spawnKey: `spawn-${index}`, created: 1, phase: "", directory: "/fixture",
    model: initial.model, profileFingerprint: "profile",
  }));
  initial.args = "";
  await store.create(initial);
  const before = await readFile(fixture.path("workflows/runs/workflow-a"), "utf8");
  const fill = 16 * 1024 * 1024 - WORKFLOW_CONTROL_HEADROOM - Buffer.byteLength(before) - 32;
  await expect(store.update(initial.id, (current) => { current.args = "x".repeat(fill); })).rejects.toThrow("headroom");
  expect(await readFile(fixture.path("workflows/runs/workflow-a"), "utf8")).toBe(before);
});
