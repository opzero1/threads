import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { authorizeWorkflowExecution, watchWorkflowExecution } from "../src/threads";
import { inspectCheckout, worktreeSteps, worktreeSweeper } from "../src/workflow-cleanup";
import { WorkflowRun } from "../src/workflow-types";
import { WORKTREE_PARENT, inside, workflowWorktreeName } from "../src/workflow-worker";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const runID = "wfr_0123456789abcdef0123456789abcdef";

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workflow-cleanup-")));
  temporary.push(root);
  const source = join(root, "repo");
  await mkdir(source);
  await git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "tracked.txt"), "base\n");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-q", "-m", "base");
  const checkout = async (key: string) => {
    const directory = join(root, WORKTREE_PARENT, workflowWorktreeName(runID, key));
    await git(source, "worktree", "add", "-q", "--detach", directory, "HEAD");
    return directory;
  };
  return { root, source, checkout };
}

function workflowRun(source: string, steps: { key: string; directory: string; isolation?: "shared" | "worktree" }[], status = "completed") {
  return WorkflowRun.parse({
    version: 1, id: runID, key: "task", ownerID: "owner", callerAgent: "build", model: { providerID: "fixture", id: "fixture" },
    projectID: "project", directory: source, name: "cleanup", description: "cleanup", script: "script", args: null,
    fingerprint: "fingerprint", limits: {}, status, created: 1, updated: 1, phase: "", logs: [], checkpoints: [],
    deliveryID: "delivery", delivered: true,
    steps: steps.map(({ key, directory, isolation = "worktree" }, index) => ({
      status: "completed", key, fingerprint: key, index, workerID: `worker-${key}`, spawnKey: key, created: 1, phase: "",
      directory, model: { providerID: "fixture", id: "fixture" }, profileFingerprint: "profile", completed: 1,
      usage: { tokens: 0, cost: 0, measured: true },
      report: { verdict: "PASS", summary: "done", evidence: [], result: null },
      input: { key, prompt: key, agent: "analyst", access: "write", isolation },
    })),
  });
}

// Mirrors OpenCode 2.0.28: `git worktree remove` without --force, and forceRequired for a dirty checkout.
function context(source: string, registered: Map<string, string>, workerProject = "project") {
  const removals: { projectID: string; directory: string; force: boolean }[] = [];
  const owner = { directory: source };
  const running = new Set<string>();
  const probeErrors = new Map<string, unknown>();
  const ctx = {
    session: {
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "owner") return { id: sessionID, projectID: "project", location: owner };
        return { id: sessionID, projectID: workerProject, location: { directory: source } };
      },
      wait: ({ sessionID }: { sessionID: string }) => probeErrors.has(sessionID) ? Promise.reject(probeErrors.get(sessionID))
        : running.has(sessionID) ? new Promise<void>(() => {}) : Promise.resolve(),
    },
    worktree: {
      async list({ projectID }: { projectID: string }) {
        return [...registered].filter(([, project]) => project === projectID).map(([directory]) => ({ directory }));
      },
      async remove(input: { projectID: string; directory: string; force: boolean }) {
        removals.push(input);
        if (registered.get(input.directory) !== input.projectID) throw new Error(`Invalid worktree directory: ${input.directory}`);
        try {
          await git(source, "worktree", "remove", ...(input.force ? ["--force"] : []), input.directory);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), { _tag: "Git.WorktreeError", forceRequired: /contains modified or untracked files|is dirty/i.test(message) });
        }
        registered.delete(input.directory);
      },
    },
  } as unknown as Pick<Plugin.Context, "session" | "worktree">;
  return { ctx, removals, owner, running, probeErrors };
}

describe("checkout inspection", () => {
  test("reports changes, commits that only HEAD holds, and clean checkouts", async () => {
    const fixture = await repository();
    const clean = await fixture.checkout("clean");
    expect(await inspectCheckout(clean)).toBe("clean");

    const untracked = await fixture.checkout("untracked");
    await writeFile(join(untracked, "new.txt"), "new\n");
    expect(await inspectCheckout(untracked)).toBe("changes");

    const modified = await fixture.checkout("modified");
    await writeFile(join(modified, "tracked.txt"), "changed\n");
    expect(await inspectCheckout(modified)).toBe("changes");

    const detached = await fixture.checkout("detached");
    await git(detached, "commit", "-q", "--allow-empty", "-m", "detached work");
    expect(await inspectCheckout(detached)).toBe("commits");

    const branched = await fixture.checkout("branched");
    await git(branched, "switch", "-q", "-c", "feature/kept");
    await git(branched, "commit", "-q", "--allow-empty", "-m", "branch work");
    expect(await inspectCheckout(branched)).toBe("clean");
  });

  test("refuses a directory that is not the top of its own checkout", async () => {
    const fixture = await repository();
    const nested = join(fixture.source, "nested");
    await mkdir(nested);
    await expect(inspectCheckout(nested)).rejects.toThrow("is not the top of a git checkout");
    await expect(inspectCheckout(fixture.root)).rejects.toThrow();
  });
});

describe("worktree sweeper", () => {
  test("selects only the step worktrees this run planned", async () => {
    const fixture = await repository();
    const planned = join(fixture.root, WORKTREE_PARENT, workflowWorktreeName(runID, "write"));
    const run = workflowRun(fixture.source, [
      { key: "write", directory: planned },
      { key: "shared", directory: fixture.source, isolation: "shared" },
      { key: "elsewhere", directory: join(fixture.root, WORKTREE_PARENT, "workflow-other") },
    ]);
    expect(worktreeSteps(run).map((step) => step.key)).toEqual(["write"]);
  });

  test("removes clean checkouts without force, keeps changed ones, and keeps branches", async () => {
    const fixture = await repository();
    // One at a time: a concurrent `git worktree add` can read another's half-written entry.
    const directories: Record<string, string> = {};
    for (const key of ["clean", "branched", "dirty", "detached", "racing", "unregistered"]) directories[key] = await fixture.checkout(key);
    await git(directories.branched, "switch", "-q", "-c", "feature/kept");
    await git(directories.branched, "commit", "-q", "--allow-empty", "-m", "branch work");
    await writeFile(join(directories.dirty, "new.txt"), "new\n");
    await git(directories.detached, "commit", "-q", "--allow-empty", "-m", "detached work");
    await writeFile(join(directories.racing, "late.txt"), "late\n");
    const registered = new Map(Object.entries(directories).filter(([key]) => key !== "unregistered").map(([, directory]) => [directory, "source-project"]));
    const run = workflowRun(fixture.source, [
      ...Object.entries(directories).map(([key, directory]) => ({ key, directory })),
      { key: "gone", directory: join(fixture.root, WORKTREE_PARENT, workflowWorktreeName(runID, "gone")) },
    ]);
    // The worker session records the source project, which differs from the owner's here.
    const { ctx, removals } = context(fixture.source, registered, "source-project");
    const sweep = worktreeSweeper(ctx, (directory) => directory === directories.racing ? Promise.resolve("clean") : inspectCheckout(directory), async () => [run]);
    const results: Record<string, string> = {};
    for (const step of run.steps) {
      const result = await sweep(run, step, true);
      results[step.key] = result.reason ? `${result.outcome}:${result.reason}` : result.outcome;
    }
    expect(results).toEqual({
      clean: "removed",
      branched: "removed",
      dirty: "kept:changes",
      detached: "kept:commits",
      racing: "kept:changes",
      unregistered: "kept:unregistered",
      gone: "missing",
    });
    expect(removals).toEqual([
      { projectID: "source-project", directory: directories.clean, force: false },
      { projectID: "source-project", directory: directories.branched, force: false },
      { projectID: "source-project", directory: directories.racing, force: false },
    ]);
    expect(await exists(directories.clean)).toBe(false);
    expect(await exists(directories.branched)).toBe(false);
    for (const key of ["dirty", "detached", "racing", "unregistered"]) expect(await exists(directories[key])).toBe(true);
    expect(await git(fixture.source, "branch", "--list", "feature/kept")).toContain("feature/kept");
    const listed = await git(fixture.source, "worktree", "list", "--porcelain");
    expect(listed).not.toContain(directories.clean);
    expect(listed).toContain(directories.dirty);
  });

  test("a dry run inspects without removing, and an unfinished run's use keeps the checkout", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const registered = new Map([[directory, "project"]]);
    const run = workflowRun(fixture.source, [{ key: "write", directory }]);
    const { ctx, removals } = context(fixture.source, registered);
    const runs = [run];
    const sweep = worktreeSweeper(ctx, inspectCheckout, async () => runs);
    expect(await sweep(run, run.steps[0], false)).toEqual({ outcome: "would-remove" });
    const user = { ...workflowRun(fixture.source, [{ key: "check", directory: fixture.source, isolation: "shared" }], "paused"), id: "wfr_other" };
    user.steps[0].input.directory = join(directory, "src");
    runs.push(user);
    expect(await sweep(run, run.steps[0], true)).toMatchObject({ outcome: "kept", reason: "in-use", message: "Unfinished workflow wfr_other (paused) uses this directory." });
    expect(removals).toEqual([]);
    expect(await exists(directory)).toBe(true);
  });

  test("keeps a checkout that its owner or the caller is located in", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const run = workflowRun(fixture.source, [{ key: "write", directory }]);
    const located = context(fixture.source, new Map([[directory, "project"]]));
    located.owner.directory = join(directory, ".");
    const runs = async () => [run];
    expect(await worktreeSweeper(located.ctx, inspectCheckout, runs)(run, run.steps[0], true))
      .toEqual({ outcome: "kept", reason: "in-use", message: "A conversation is located in this directory." });
    const calling = context(fixture.source, new Map([[directory, "project"]]));
    expect(await worktreeSweeper(calling.ctx, inspectCheckout, runs, { occupied: [directory] })(run, run.steps[0], true))
      .toMatchObject({ outcome: "kept", reason: "in-use" });
    expect([...located.removals, ...calling.removals]).toEqual([]);
    expect(await worktreeSweeper(calling.ctx, inspectCheckout, runs, { occupied: [fixture.source] })(run, run.steps[0], true)).toEqual({ outcome: "removed" });
  });

  test("keeps a checkout while a worker in it runs or holds an execution grant", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const run = workflowRun(fixture.source, [{ key: "write", directory }]);
    const { ctx, removals, running } = context(fixture.source, new Map([[directory, "project"]]));
    const sweep = worktreeSweeper(ctx, inspectCheckout, async () => [run]);
    running.add("worker-write");
    expect(await sweep(run, run.steps[0], true)).toEqual({ outcome: "kept", reason: "in-use", message: "A worker in this directory is still running." });
    running.delete("worker-write");
    authorizeWorkflowExecution("worker-write");
    try {
      expect(await sweep(run, run.steps[0], true)).toMatchObject({ outcome: "kept", reason: "in-use" });
    } finally {
      watchWorkflowExecution("worker-write", () => Promise.resolve());
      await Bun.sleep(0);
    }
    expect(removals).toEqual([]);
    expect(await sweep(run, run.steps[0], true)).toEqual({ outcome: "removed" });
  });

  test("keeps a checkout when it cannot confirm that a worker in it is idle", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const run = workflowRun(fixture.source, [{ key: "write", directory }]);
    const { ctx, removals, probeErrors } = context(fixture.source, new Map([[directory, "project"]]));
    const sweep = worktreeSweeper(ctx, async () => "clean", async () => [run]);
    probeErrors.set("worker-write", { _tag: "ServiceUnavailableError", message: "session service unavailable" });
    expect(await sweep(run, run.steps[0], true)).toEqual({
      outcome: "kept", reason: "error", message: "Could not confirm that a worker in this directory is idle: session service unavailable",
    });
    probeErrors.set("worker-write", { _tag: "Session.NotFoundError", sessionID: "worker-other" });
    expect(await sweep(run, run.steps[0], true)).toMatchObject({ outcome: "kept", reason: "error" });
    expect(removals).toEqual([]);
    probeErrors.set("worker-write", { _tag: "Session.NotFoundError", sessionID: "worker-write" });
    expect(await sweep(run, run.steps[0], true)).toEqual({ outcome: "removed" });
  });

  test("a stopped pass removes nothing", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const run = workflowRun(fixture.source, [{ key: "write", directory }]);
    const { ctx, removals } = context(fixture.source, new Map([[directory, "project"]]));
    const stop = new AbortController();
    const sweep = worktreeSweeper(ctx, inspectCheckout, async () => [run], { signal: stop.signal });
    stop.abort();
    expect(await sweep(run, run.steps[0], true)).toEqual({ outcome: "kept", reason: "error", message: "Cleanup stopped before it finished." });
    expect(removals).toEqual([]);
    expect(await exists(directory)).toBe(true);
  });

  test("stopping an inspection kills its running git", async () => {
    const fixture = await repository();
    const directory = await fixture.checkout("write");
    const bin = join(fixture.root, "slow-git");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\necho $$ > "${join(fixture.root, "git.pid")}"\nexec sleep 30\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const stop = new AbortController();
      const inspection = inspectCheckout(directory, stop.signal);
      while (!await exists(join(fixture.root, "git.pid"))) await Bun.sleep(5);
      const before = Date.now();
      stop.abort();
      await expect(inspection).rejects.toThrow();
      expect(Date.now() - before).toBeLessThan(2_000);
      const pid = Number((await readFile(join(fixture.root, "git.pid"), "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      process.env.PATH = path;
    }
  });

  test("a child whose name starts with two dots is inside its parent", () => {
    expect(inside("/work/checkout/..cache/inner", "/work/checkout")).toBe(true);
    expect(inside("/work/checkout", "/work/checkout")).toBe(true);
    expect(inside("/work/other", "/work/checkout")).toBe(false);
    expect(inside("/work", "/work/checkout")).toBe(false);
  });

  test("keeps a clean checkout that holds another worktree, even an ignored one", async () => {
    const fixture = await repository();
    const outer = await fixture.checkout("outer");
    await mkdir(join(outer, "..cache"));
    await writeFile(join(fixture.source, ".git", "info", "exclude"), `${WORKTREE_PARENT}/\n`);
    const inner = join(outer, "..cache", WORKTREE_PARENT, workflowWorktreeName(runID, "inner"));
    await git(fixture.source, "worktree", "add", "-q", "--detach", inner, "HEAD");
    await writeFile(join(inner, "tracked.txt"), "inner change\n");
    expect(await git(outer, "status", "--porcelain")).toBe("");
    expect(await inspectCheckout(outer)).toBe("nested");

    const registered = new Map([[outer, "project"], [inner, "project"]]);
    const run = workflowRun(fixture.source, [{ key: "outer", directory: outer }, { key: "inner", directory: inner }]);
    const { ctx, removals } = context(fixture.source, registered);
    const recordsOnly = worktreeSweeper(ctx, async () => "clean", async () => [run]);
    expect(await recordsOnly(run, run.steps[0], true)).toEqual({ outcome: "kept", reason: "nested", message: "Another worktree is inside this checkout." });
    const sweep = worktreeSweeper(ctx, inspectCheckout, async () => [run]);
    expect(await sweep(run, run.steps[0], true)).toMatchObject({ outcome: "kept", reason: "nested" });
    expect(await sweep(run, run.steps[1], true)).toMatchObject({ outcome: "kept", reason: "changes" });
    expect(removals).toEqual([]);
    expect(await readFile(join(inner, "tracked.txt"), "utf8")).toBe("inner change\n");

    await git(inner, "checkout", "--", "tracked.txt");
    expect(worktreeSteps(run).map((step) => step.key)).toEqual(["inner", "outer"]);
    for (const step of worktreeSteps(run)) expect(await sweep(run, step, true)).toEqual({ outcome: "removed" });
    expect(await exists(outer)).toBe(false);
  });
});
