import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { workflowHash, workflowStore } from "../src/workflow-store";
import { Json, WorkflowRun } from "../src/workflow-types";

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
  await expect(workflowStore(fixture.storage).get("workflow-a")).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8")).version).toBe(99);
});

test("fingerprints are independent of object insertion order and preserve array order", () => {
  expect(workflowHash({ b: 2, a: { z: 1, y: 2 } })).toBe(workflowHash({ a: { y: 2, z: 1 }, b: 2 }));
  expect(workflowHash(["a", "b"])).not.toBe(workflowHash(["b", "a"]));
});
