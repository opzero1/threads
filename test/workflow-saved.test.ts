import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { savedWorkflows } from "../src/workflow-saved";
import { workflows } from "../src/workflows";

const paths: string[] = [];
async function directory() {
  await mkdir(join(import.meta.dir, "../.audit"), { recursive: true });
  const path = await mkdtemp(join(import.meta.dir, "../.audit/saved-"));
  paths.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const script = 'export const meta = {name:"audit",description:"Audit"}; return args;';

test("saved workflow round trip preserves script, overwrites only on request, and refuses traversal", async () => {
  const root = await directory();
  const saved = savedWorkflows(root, root);
  const output = await saved.save("audit", script, "project");
  expect(await readFile(output.path, "utf8")).toBe(script);
  expect(await saved.load("audit")).toBe(script);
  expect((await saved.list()).find((item) => item.name === "audit")).toMatchObject({ scope: "project", description: "Audit" });
  await expect(saved.save("audit", script + "\n", "project")).rejects.toThrow();
  await expect(saved.save("../escape", script, "project")).rejects.toThrow();
  expect(await readFile(output.path, "utf8")).toBe(script);
  const replacement = 'export const meta = {name:"audit",description:"Audit again",whenToUse:"After a release"}; return 1;';
  expect(await saved.save("audit", replacement, "project", true)).toEqual(output);
  expect(await saved.load("audit")).toBe(replacement);
  expect((await saved.list()).find((item) => item.name === "audit")).toMatchObject({ description: "Audit again", whenToUse: "After a release" });
  await expect(saved.save("other", 'export const meta = {name:"o",description:"O",whenToUse:1}; return 1;', "project")).rejects.toThrow("whenToUse");
});

test("project save refuses symlinked directories and files", async () => {
  const root = await directory();
  const elsewhere = await directory();
  await symlink(elsewhere, join(root, ".opencode"));
  await expect(savedWorkflows(root, root).save("audit", script, "project")).rejects.toThrow("symlink");
  await rm(join(root, ".opencode"));
  await mkdir(join(root, ".opencode/workflows"), { recursive: true });
  const protectedFile = join(elsewhere, "original.js");
  await writeFile(protectedFile, "untouched");
  await symlink(protectedFile, join(root, ".opencode/workflows/audit.js"));
  await expect(savedWorkflows(root, root).save("audit", script, "project")).rejects.toThrow();
  await expect(savedWorkflows(root, root).save("audit", script, "project", true)).rejects.toThrow();
  expect(await readFile(protectedFile, "utf8")).toBe("untouched");
});

test("a malformed saved script remains visible without preventing valid workflows from loading", async () => {
  const root = await directory();
  const saved = savedWorkflows(root, root);
  await saved.save("audit", script, "project");
  await writeFile(join(root, ".opencode/workflows/broken.js"), "broken syntax {");
  expect((await saved.list()).find((item) => item.name === "broken")?.description).toContain("Invalid workflow");
  expect(await saved.load("audit")).toBe(script);
});

test("saved workflows register no per-script commands and refresh only warms the location", async () => {
  const root = await directory();
  await savedWorkflows(root, root).save("audit", script, "project");
  const commands = new Map<string, { execute: () => Promise<void> }>();
  let reloads = 0;
  // The adapter supplies only registration surfaces; workflows() registers its production commands unchanged.
  const ctx = {
    options: {},
    location: { directory: root, project: { canonical: root } },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    session: { hook: async () => {} },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    tool: { transform: async () => {}, hook: async () => ({ dispose: async () => {} }) },
    skill: { transform: async () => {} },
    command: {
      transform: async (register: (editor: { add: (command: { name: string; execute: () => Promise<void> }) => void }) => void) =>
        register({ add: (command) => { commands.set(command.name, command); } }),
      reload: async () => { reloads++; },
    },
  } as unknown as Plugin.Context;
  const dispose = await workflows(ctx, {} as never, new Map(), 1);
  try {
    expect([...commands.keys()].sort()).toEqual(["workflow-refresh", "workflow-run"]);
    await commands.get("workflow-refresh")!.execute();
    expect(reloads).toBe(0);
  } finally {
    await dispose();
  }
});
