import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savedWorkflows } from "../src/workflow-saved";

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

test("saved workflow round trip preserves script and refuses overwrite or traversal", async () => {
  const root = await directory();
  const saved = savedWorkflows(root, root);
  const output = await saved.save("audit", script, "project");
  expect(await readFile(output.path, "utf8")).toBe(script);
  expect(await saved.load("audit")).toBe(script);
  expect((await saved.list()).find((item) => item.name === "audit")?.scope).toBe("project");
  await expect(saved.save("audit", script + "\n", "project")).rejects.toThrow();
  await expect(saved.save("../escape", script, "project")).rejects.toThrow();
  expect(await readFile(output.path, "utf8")).toBe(script);
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
