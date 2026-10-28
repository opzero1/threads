import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { workflowHash, workflowStore } from "../src/workflow-store";
import {
  Json, WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES, WORKFLOW_REJECTION_DIAGNOSTIC_JSON_BYTES, WORKFLOW_REJECTION_RESERVE_BYTES,
  WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES, WorkflowRun, workflowSummary,
} from "../src/workflow-types";

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

test("compacted legacy limits stay finite while explicit null budgets survive reopen and RPC summaries", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  await fixture.storage.set("workflows/runs/legacy", Json.parse({ ...run("legacy"), limits: {} }));
  const defaults = { concurrency: 3, maxAgents: 4, agentTimeoutMs: 1_800_000, timeoutMs: 86_400_000 };
  expect((await store.get("legacy")).limits).toEqual(defaults);
  await store.update("legacy", (draft) => { draft.phase = "resumed"; });
  expect(await fixture.storage.get("workflows/runs/legacy")).toMatchObject({ limits: defaults });
  const unbounded = run("unbounded");
  unbounded.limits = { concurrency: 3, maxAgents: null, agentTimeoutMs: null, timeoutMs: null, tokenBudget: null };
  await store.create(unbounded);
  const reopened = workflowStore(fixture.storage);
  await reopened.update(unbounded.id, (draft) => { draft.phase = "resumed"; });
  expect((await fixture.storage.get("workflows/runs/unbounded"))).toMatchObject({ limits: {
    maxAgents: null, agentTimeoutMs: null, timeoutMs: null, tokenBudget: null,
  } });
  expect(workflowSummary(await reopened.get(unbounded.id)).limits).toEqual(unbounded.limits);
  expect((await reopened.list("owner-a")).find((item) => item.id === unbounded.id)?.limits).toEqual(unbounded.limits);
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

test("records without cleanup fields load, cleanup outcomes round-trip, and all() spans owners", async () => {
  const fixture = await disk();
  const legacy = { ...run("legacy"), status: "completed", delivered: true } as Record<string, unknown>;
  expect("finished" in legacy || "worktreeCleanup" in legacy).toBe(false);
  await writeFile(fixture.path("workflows/runs/legacy"), JSON.stringify(legacy));
  await writeFile(fixture.path("workflows/runs/corrupt"), JSON.stringify({ ...run("corrupt"), version: 99 }));
  const store = workflowStore(fixture.storage);
  await store.create(run("other", "owner-b"));
  const loaded = await store.get("legacy");
  expect(loaded.finished).toBeUndefined();
  expect(loaded.worktreeCleanup).toBeUndefined();
  const outcome = { key: "write", directory: "/fixture/.opencode-workflows/workflow-x", outcome: "kept" as const, reason: "changes" as const, message: "dirty", at: 5 };
  await store.update("legacy", (draft) => {
    draft.finished = 4;
    draft.worktreeCleanup = { complete: true, worktrees: [outcome] };
  }, "control");
  const reopened = await workflowStore(fixture.storage).get("legacy");
  expect(reopened.finished).toBe(4);
  expect(reopened.worktreeCleanup).toEqual({ complete: true, worktrees: [outcome] });
  expect("worktreeCleanup" in workflowSummary(reopened)).toBe(false);
  expect(workflowSummary(reopened).finished).toBe(4);
  expect((await store.all()).map((item) => item.id).sort()).toEqual(["legacy", "other"]);
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["legacy"]);
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

test("control headroom fits a full rejection record, failure, and settlement for every unfinished step", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  const initial = run();
  initial.status = "running";
  initial.limits.maxAgents = 32;
  initial.steps = Array.from({ length: 32 }, (_, index) => ({
    status: "running", key: `step-${index}`, fingerprint: "input", index,
    input: { key: `step-${index}`, prompt: "read", agent: "analyst", access: "read", isolation: "shared" },
    workerID: `worker-${index}`, spawnKey: `spawn-${index}`, created: 1, phase: "", directory: "/fixture",
    model: initial.model, profileFingerprint: "profile",
  }));
  initial.args = "";
  initial.settlements = [];
  await store.create(initial);
  // Measure after one update: updates replace the fixture's `updated: 1` with a 13-digit timestamp.
  await store.update(initial.id, (current) => { current.args = ""; });
  const base = Buffer.byteLength(await readFile(fixture.path("workflows/runs/workflow-a"), "utf8"));
  const perStep = (key: string) => Buffer.byteLength(JSON.stringify({ kind: "agent", key, outcome: "failure", error: "" }), "utf8")
    + WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES + 1 + WORKFLOW_REJECTION_RESERVE_BYTES + WORKFLOW_DIAGNOSTIC_JSON_BYTES + 256;
  const headroom = Math.max(WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES + 256 + initial.steps.reduce((sum, step) => sum + perStep(step.key), 0));
  const fill = 16 * 1024 * 1024 - headroom - base;
  await expect(store.update(initial.id, (current) => { current.args = "x".repeat(fill + 1); })).rejects.toThrow("headroom");
  await store.update(initial.id, (current) => { current.args = "x".repeat(fill); });
  const exhausted = await store.update(initial.id, (current) => {
    current.steps = current.steps.map((step) => ({
      ...step, status: "failed", retryable: false, error: "e".repeat(WORKFLOW_DIAGNOSTIC_JSON_BYTES),
      rejections: { count: 5, calls: Array.from({ length: 5 }, (_, call) => `${call}`.repeat(32)), error: "r".repeat(WORKFLOW_REJECTION_DIAGNOSTIC_JSON_BYTES), interrupt: "pending" },
    }) as WorkflowRun["steps"][number]);
    current.settlements = current.steps.map((step) => ({ kind: "agent", key: step.key, outcome: "failure", error: "s".repeat(WORKFLOW_SETTLEMENT_DIAGNOSTIC_JSON_BYTES) }));
  }, "control");
  expect(exhausted.steps.every((step) => step.rejections?.count === 5)).toBe(true);
  expect(Buffer.byteLength(await readFile(fixture.path("workflows/runs/workflow-a"), "utf8"))).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("control headroom fits cap errors replacing short errors on failed, settled steps", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  const initial = run();
  initial.status = "interrupted";
  initial.limits.maxAgents = 100;
  initial.steps = Array.from({ length: 100 }, (_, index) => ({
    status: "failed", error: "short", retryable: true, key: `step-${index}`, fingerprint: "input", index,
    input: { key: `step-${index}`, prompt: "read", agent: "analyst", access: "read", isolation: "shared" },
    workerID: `worker-${index}`, spawnKey: `spawn-${index}`, created: 1, phase: "", directory: "/fixture",
    model: initial.model, profileFingerprint: "profile",
  }));
  initial.settlements = initial.steps.map((step) => ({ kind: "agent", key: step.key, outcome: "failure", error: "short" }));
  initial.args = "";
  await store.create(initial);
  // Measure after one update: updates replace the fixture's `updated: 1` with a 13-digit timestamp.
  await store.update(initial.id, (current) => { current.args = ""; });
  const base = Buffer.byteLength(await readFile(fixture.path("workflows/runs/workflow-a"), "utf8"));
  // Settled failed steps reserve no settlement, only the rejection record, the error's growth to the
  // diagnostic bound, and one byte for retryable becoming false.
  const perStep = WORKFLOW_REJECTION_RESERVE_BYTES + WORKFLOW_DIAGNOSTIC_JSON_BYTES + 2 - Buffer.byteLength(JSON.stringify("short")) + 1;
  const headroom = Math.max(WORKFLOW_CONTROL_HEADROOM, WORKFLOW_DIAGNOSTIC_JSON_BYTES + 256 + 100 * perStep);
  expect(headroom).toBeGreaterThan(WORKFLOW_CONTROL_HEADROOM);
  const fill = 16 * 1024 * 1024 - headroom - base;
  await expect(store.update(initial.id, (current) => { current.args = "x".repeat(fill + 1); })).rejects.toThrow("headroom");
  await store.update(initial.id, (current) => { current.args = "x".repeat(fill); });
  const exhausted = await store.update(initial.id, (current) => {
    current.steps = current.steps.map((step) => ({
      ...step, status: "failed", retryable: false, error: "e".repeat(WORKFLOW_DIAGNOSTIC_JSON_BYTES),
      rejections: { count: 5, calls: Array.from({ length: 5 }, (_, call) => `${call}`.repeat(32)), error: "r".repeat(WORKFLOW_REJECTION_DIAGNOSTIC_JSON_BYTES), interrupt: "pending" },
    }) as WorkflowRun["steps"][number]);
  }, "control");
  expect(exhausted.steps.every((step) => step.rejections?.count === 5)).toBe(true);
  expect(Buffer.byteLength(await readFile(fixture.path("workflows/runs/workflow-a"), "utf8"))).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("stores each checkpoint answer once and derives it on every read", async () => {
  const fixture = await disk();
  const store = workflowStore(fixture.storage);
  const legacy = { ...run(), checkpoints: [{ key: "a", prompt: "A", response: "old" }, { key: "b", prompt: "B" }], settlements: [{ kind: "checkpoint", key: "a", response: "old" }] };
  await fixture.storage.set("workflows/runs/workflow-a", Json.parse(legacy));
  expect((await store.get("workflow-a")).checkpoints.map((item) => item.response)).toEqual(["old", undefined]);
  const updated = await store.update("workflow-a", (draft) => { draft.settlements!.push({ kind: "checkpoint", key: "b", response: true }); });
  expect(updated.checkpoints.map((item) => item.response)).toEqual(["old", true]);
  const stored = await fixture.storage.get("workflows/runs/workflow-a") as WorkflowRun;
  expect(stored.checkpoints.map((item) => "response" in item)).toEqual([false, false]);
  for (const read of [await store.get("workflow-a"), (await store.list("owner-a"))[0], (await store.all())[0]]) {
    expect(read.checkpoints.map((item) => item.response)).toEqual(["old", true]);
  }
});

// Counts journal values the host decodes: every workflows/runs/ value a get or scan returns.
function counted(storage: Plugin.Context["storage"]) {
  const stats = { runScans: 0, runDecodes: 0 };
  const isRun = (key: string) => key.startsWith("workflows/runs/");
  const wrapped: Plugin.Context["storage"] = {
    ...storage,
    async get(key) {
      const value = await storage.get(key);
      if (isRun(key) && value !== undefined) stats.runDecodes++;
      return value;
    },
    async scan(input) {
      const page = await storage.scan(input);
      if (input.prefix.startsWith("workflows/runs/")) stats.runScans++;
      stats.runDecodes += page.entries.filter((entry) => isRun(entry.key)).length;
      return page;
    },
  };
  return { storage: wrapped, stats, reset: () => Object.assign(stats, { runScans: 0, runDecodes: 0 }) };
}

test("listing decodes only the owner's journals after one backfill of runs written without the index", async () => {
  const fixture = await disk();
  // Runs written directly, as earlier versions did, have no owner index entry.
  for (let index = 0; index < 120; index++) {
    await fixture.storage.set(`workflows/runs/other-${index}`, Json.parse({ ...run(`other-${index}`, "owner-b"), logs: [{ time: 1, text: "x".repeat(2_000) }] }));
  }
  await fixture.storage.set("workflows/runs/mine-legacy", Json.parse(run("mine-legacy")));
  const meter = counted(fixture.storage);
  const store = workflowStore(meter.storage);
  await store.create({ ...run("mine-new"), created: 2 });

  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["mine-new", "mine-legacy"]);
  // The first list pays one full scan (2 pages of 100) to backfill the index, plus the owner's reads.
  expect(meter.stats).toEqual({ runScans: 2, runDecodes: 122 + 2 });

  meter.reset();
  for (let index = 0; index < 5; index++) expect(await store.list("owner-a")).toHaveLength(2);
  expect(meter.stats).toEqual({ runScans: 0, runDecodes: 5 * 2 });

  // A reopened store backfills once more and keeps every owner's runs.
  meter.reset();
  const reopened = workflowStore(meter.storage);
  expect(await reopened.list("owner-b")).toHaveLength(120);
  expect(meter.stats.runScans).toBe(2);
  meter.reset();
  expect((await reopened.list("owner-a")).map((item) => item.id)).toEqual(["mine-new", "mine-legacy"]);
  expect(meter.stats).toEqual({ runScans: 0, runDecodes: 2 });
});

test("indexed listings show fresh writes, new runs, and corrupt records, and skip an unwritten run", async () => {
  const fixture = await disk();
  const diagnostics: string[] = [];
  const meter = counted(fixture.storage);
  const store = workflowStore(meter.storage, { onDiagnostic: async (issue) => { diagnostics.push(`${issue.ownerID}:${issue.id}`); } });
  await store.create(run("first"));
  expect((await store.list("owner-a"))[0]?.phase).toBe("");

  await store.update("first", (draft) => { draft.phase = "Review"; });
  expect((await store.list("owner-a"))[0]?.phase).toBe("Review");
  // A write that bypasses the store, such as recovery evidence, is read fresh too.
  await fixture.storage.set("workflows/runs/first", Json.parse({ ...(await store.get("first")), phase: "External" }));
  expect((await store.list("owner-a"))[0]?.phase).toBe("External");

  // Another store instance over the same storage, such as a second OpenCode process.
  const peer = workflowStore(fixture.storage);
  await peer.create({ ...run("second"), created: 2 });
  await peer.create(run("foreign", "owner-b"));
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["second", "first"]);
  expect((await store.list("owner-b")).map((item) => item.id)).toEqual(["foreign"]);

  // A record replaced by a corrupt one stays indexed, so its owner keeps getting the diagnostic.
  await writeFile(fixture.path("workflows/runs/second"), JSON.stringify({ ...run("second"), version: 99 }));
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["first"]);
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["first"]);
  expect(diagnostics).toEqual(["owner-a:second", "owner-a:second"]);

  // An index entry whose run write never landed lists nothing.
  await fixture.storage.set("workflows/owners/owner-a/missing", true);
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["first"]);
  expect(meter.stats.runScans).toBe(1);
});

test("a failed backfill is retried by the next list", async () => {
  const fixture = await disk();
  await fixture.storage.set("workflows/runs/legacy", Json.parse(run("legacy")));
  let fail = true;
  const store = workflowStore({
    ...fixture.storage,
    async scan(input) {
      if (fail && input.prefix === "workflows/runs/") throw new Error("storage unavailable");
      return fixture.storage.scan(input);
    },
  });
  await expect(store.list("owner-a")).rejects.toThrow("storage unavailable");
  fail = false;
  expect((await store.list("owner-a")).map((item) => item.id)).toEqual(["legacy"]);
});
