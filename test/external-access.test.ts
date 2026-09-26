import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import type { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { projectRoot, recordedGrants, resolveGrantedPaths, withResolvedGrants } from "../src/external-access";
import { permissionMatches } from "../src/permissions";
import { threads, workerIdentity } from "../src/threads";
import { WorkflowAgentInput, type WorkflowRun } from "../src/workflow-types";
import { assertGrantedProject, assertWorkerProject, workflowSource } from "../src/workflow-worker";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function scratch() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "external-access-")));
  temporary.push(directory);
  const refs = join(directory, "refs");
  const other = join(directory, "refs-other");
  const project = join(directory, "project");
  const worker = join(directory, "worker");
  for (const path of [refs, other, project, worker, join(refs, "nested")]) await mkdir(path, { recursive: true });
  await writeFile(join(refs, "file.txt"), "reference\n");
  await symlink(refs, join(directory, "link"));
  return { directory, refs, other, project, worker, link: join(directory, "link") };
}

describe("granted path validation", () => {
  test("resolves symlinks to real directories, removes duplicates, and sorts", async () => {
    const { refs, other, link } = await scratch();
    expect(await resolveGrantedPaths(undefined)).toBeUndefined();
    expect(await resolveGrantedPaths([])).toBeUndefined();
    expect(await resolveGrantedPaths([other, link, refs, `${refs}/nested/..`])).toEqual([refs, other].sort());
    const temporaryAlias = await mkdtemp(join(tmpdir(), "external-alias-"));
    temporary.push(temporaryAlias);
    expect(await resolveGrantedPaths([temporaryAlias])).toEqual([await realpath(temporaryAlias)]);
  });

  test("rejects relative, missing, non-directory, root, and wildcard paths", async () => {
    const { directory, refs } = await scratch();
    await expect(resolveGrantedPaths(["refs"])).rejects.toThrow("must be absolute");
    await expect(resolveGrantedPaths([join(directory, "missing")])).rejects.toThrow("must be an existing directory");
    await expect(resolveGrantedPaths([join(refs, "file.txt")])).rejects.toThrow("must be an existing directory");
    await expect(resolveGrantedPaths(["/"])).rejects.toThrow("filesystem root");
    await expect(resolveGrantedPaths([refs, join(directory, "missing")])).rejects.toThrow("missing");
    for (const name of ["star*dir", "question?dir"]) {
      await mkdir(join(directory, name));
      await expect(resolveGrantedPaths([join(directory, name)])).rejects.toThrow("cannot match literally");
    }
    // Bun resolves a POSIX backslash as a separator; the path is rejected either way.
    await mkdir(join(directory, "back\\slash"));
    await expect(resolveGrantedPaths([join(directory, "back\\slash")])).rejects.toThrow();
  });

  test("canonical inputs drop empty grants and records reject malformed metadata", async () => {
    const { refs, link } = await scratch();
    const input = WorkflowAgentInput.parse({ key: "a", prompt: "p", agent: "reader", paths: [] });
    expect("paths" in await withResolvedGrants(input)).toBe(false);
    expect((await withResolvedGrants({ ...input, paths: [link] })).paths).toEqual([refs]);
    expect(recordedGrants(undefined)).toBeUndefined();
    expect(recordedGrants({ opThreadsPaths: [refs] })).toEqual([refs]);
    expect(() => recordedGrants({ opThreadsPaths: "not-a-list" })).toThrow();
    expect(() => WorkflowAgentInput.parse({ ...input, paths: Array.from({ length: 17 }, () => refs) })).toThrow();
  });
});

describe("workflow directory containment", () => {
  const run = (directory: string) => ({ directory, projectID: "project" }) as WorkflowRun;
  const ctx = (worktrees: string[] = []) => ({ worktree: { list: async () => worktrees.map((directory) => ({ directory })) } }) as unknown as Pick<Plugin.Context, "worktree">;

  test("a step may run inside a granted path but not beside it", async () => {
    const { refs, other, project } = await scratch();
    const step = (directory: string, paths?: string[]) => WorkflowAgentInput.parse({ key: "a", prompt: "p", agent: "reader", directory, paths });
    expect(await workflowSource(ctx(), run(project), step(join(refs, "nested"), [refs]))).toEqual({ directory: join(refs, "nested"), granted: true });
    expect(await workflowSource(ctx(), run(project), step(refs, [refs]))).toEqual({ directory: refs, granted: true });
    await expect(workflowSource(ctx(), run(project), step(other, [refs]))).rejects.toThrow("or a granted path");
    await expect(workflowSource(ctx(), run(project), step(refs))).rejects.toThrow("inside the owner project");
    expect(await workflowSource(ctx([refs]), run(project), step(refs))).toEqual({ directory: refs, granted: false });
    // The owner's own project and worktrees need no project check, even when a grant also covers them.
    expect(await workflowSource(ctx(), run(project), step(project, [project]))).toEqual({ directory: project, granted: false });
  });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

async function repository(path: string) {
  await mkdir(join(path, "project"), { recursive: true });
  await mkdir(join(path, "private"));
  await writeFile(join(path, "top.txt"), "top\n");
  git(dirname(path), "init", "-q", "-b", "main", path);
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "base");
  return path;
}

describe("worker project scope", () => {
  // Each expectation repeats what probe_scope.py observed on OpenCode 2.0.16: files under the returned
  // directory were read without an external_directory check, and files outside it were denied.
  test("project roots follow git discovery and never fall short of OpenCode's local scope", async () => {
    const { directory } = await scratch();
    const plain = join(directory, "plain");
    await mkdir(join(plain, "inner"), { recursive: true });
    const repo = await repository(join(directory, "repo"));
    git(repo, "worktree", "add", "-q", "-b", "linked", join(directory, "repo-wt"));
    const nested = join(repo, "nested-repo");
    await mkdir(nested);
    git(repo, "init", "-q", "-b", "main", nested);
    await mkdir(join(repo, "invalid-directory", ".git"), { recursive: true });
    await mkdir(join(repo, "invalid-file"));
    await writeFile(join(repo, "invalid-file", ".git"), "garbage\n");
    await mkdir(join(directory, "marker", ".git"), { recursive: true });
    await mkdir(join(directory, "marker", "inner"));

    expect(await projectRoot(join(plain, "inner"))).toBe(join(plain, "inner"));
    expect(await projectRoot(join(repo, "project"))).toBe(repo);
    expect(await projectRoot(join(directory, "repo-wt"))).toBe(join(directory, "repo-wt"));
    expect(await projectRoot(nested)).toBe(nested);
    // git skips an invalid .git directory, stops with an error at an invalid .git file, and finds no
    // repository above a marker outside one.
    expect(await projectRoot(join(repo, "invalid-directory"))).toBe(repo);
    expect(await projectRoot(join(repo, "invalid-file"))).toBe(join(repo, "invalid-file"));
    expect(await projectRoot(join(directory, "marker", "inner"))).toBe(join(directory, "marker", "inner"));
  });

  test("a step moved into a grant keeps its project inside the grants and clear of explicit denies", async () => {
    const { directory, refs } = await scratch();
    const repo = await repository(join(directory, "repo"));
    const deny = (resource: string, action = "external_directory"): Rule => ({ action, resource, effect: "deny" });
    // Outside a repository the worker's project is its directory.
    await assertGrantedProject([], [], [refs], join(refs, "nested"));
    await assertGrantedProject([deny(`${refs}/other/*`), deny("*", "*")], [], [refs], join(refs, "nested"));
    await expect(assertGrantedProject([deny(`${refs}/nested/*`)], [], [refs], join(refs, "nested")))
      .rejects.toThrow(`would make ${join(refs, "nested")} local to its worker, where the explicit external_directory deny (${refs}/nested/*) cannot apply`);
    await expect(assertGrantedProject([], [deny("*/nested/*")], [refs], refs)).rejects.toThrow("deny (*/nested/*)");
    await expect(assertGrantedProject([deny(`${refs}/nested/*`, "*")], [], [refs], refs)).rejects.toThrow(`deny (${refs}/nested/*)`);
    // Inside a repository the whole worktree is local, including paths outside the step's directory.
    await assertGrantedProject([], [], [repo], join(repo, "project"));
    await expect(assertGrantedProject([deny(`${repo}/private/*`)], [], [repo], join(repo, "project")))
      .rejects.toThrow(`would make ${repo} local`);
    await expect(assertGrantedProject([], [], [join(repo, "project")], join(repo, "project")))
      .rejects.toThrow(`Workflow directory ${join(repo, "project")} is in project ${repo}, which extends beyond its granted paths`);
    // A planned worktree checkout becomes the worker's project as well.
    const checkout = join(directory, ".opencode-workflows", "workflow-checkout");
    await expect(assertGrantedProject([deny(`${directory}/.opencode-workflows/*`)], [], [repo], repo, checkout))
      .rejects.toThrow(`would make ${checkout} local`);
  });

  test("a worker's project is checked where it runs, and a checkout that is its own project needs no grant", async () => {
    const { directory, refs } = await scratch();
    const grant = join(directory, "granted");
    const repo = await repository(join(grant, "repository"));
    const checkout = join(grant, ".opencode-workflows", "checkout");
    git(repo, "worktree", "add", "-q", "-b", "checkout", checkout);
    const deny = (resource: string): Rule => ({ action: "external_directory", resource, effect: "deny" });
    const local = `Workflow directory ${checkout} would make ${checkout} local to its worker, where the explicit external_directory deny`;
    await assertWorkerProject([], [], [grant], checkout, true);
    await assertWorkerProject([], [], [refs], checkout, true);
    await expect(assertWorkerProject([], [deny("*/.opencode-workflows/*/private/*")], [grant], checkout, true))
      .rejects.toThrow(`${local} (*/.opencode-workflows/*/private/*) cannot apply`);
    await expect(assertWorkerProject([deny(`${grant}/.opencode-workflows/*`)], [], [grant], checkout, true))
      .rejects.toThrow(`${local} (${grant}/.opencode-workflows/*) cannot apply`);
    // A deny elsewhere in the grant stays outside the checkout, where the worker's own rules apply it.
    await assertWorkerProject([], [deny(`${grant}/secret/*`)], [grant], checkout, true);
    // Any other location keeps its whole project within the grants.
    await expect(assertWorkerProject([], [], [refs], checkout, false)).rejects.toThrow(`is in project ${checkout}, which extends beyond its granted paths`);
    await expect(assertWorkerProject([], [], [join(repo, "project")], join(repo, "project"), true))
      .rejects.toThrow(`is in project ${repo}, which extends beyond its granted paths`);
    await expect(assertWorkerProject([deny(`${repo}/private/*`)], [], [grant], join(repo, "project"), false)).rejects.toThrow(`would make ${repo} local`);
  });
});

type Rule = Permission.Rule;
const decide = (rules: readonly Rule[], action: string, resource: string) =>
  rules.findLast((rule) => permissionMatches(rule.action, action) && permissionMatches(rule.resource, resource))?.effect ?? "ask";
const defaults: Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
];

async function fakeThreads(options: { coordinatorPermissions?: Rule[]; profiles?: Record<string, Rule[]>; coldLookups?: number } = {}) {
  const paths = await scratch();
  const sessions = new Map<string, Record<string, any>>();
  const storage = new Map<string, unknown>();
  const created: Record<string, any>[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const updates: { sessionID: string; permissions: Rule[] }[] = [];
  const events: string[] = [];
  const agentLookups: string[] = [];
  // Like OpenCode, a Location's profile adds the rules of every ancestor directory's configuration.
  const layers: Record<string, Record<string, Rule[]>> = {};
  const profiles: Record<string, Rule[]> = {
    build: [...defaults, { action: "subagent", resource: "*", effect: "allow" }],
    writer: [...defaults, { action: "*", resource: "*", effect: "allow" }],
    reader: [...defaults, { action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
    guarded: [...defaults, { action: "external_directory", resource: `${paths.refs}/*`, effect: "deny" }],
    ...options.profiles,
  };
  const coordinatorID = Session.ID.create();
  sessions.set(coordinatorID, { id: coordinatorID, location: { directory: paths.project }, permissions: options.coordinatorPermissions ?? [], metadata: {} });
  let cold = options.coldLookups ?? 0;
  let api: ReturnType<typeof threads>;
  const ctx = {
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const session = sessions.get(sessionID);
        if (!session) throw { _tag: "Session.NotFoundError", sessionID };
        return structuredClone(session);
      },
      async create(input: Record<string, any>) {
        const session = { ...structuredClone(input), projectID: "project" };
        created.push(session);
        sessions.set(input.id, session);
        return structuredClone(session);
      },
      async update(input: { sessionID: string; permissions: Rule[] }) {
        updates.push(input);
        events.push(`update ${input.sessionID}`);
        sessions.get(input.sessionID)!.permissions = input.permissions;
      },
      async prompt(input: { sessionID: string; id: string; text: string }) {
        prompts.push(input);
        events.push(`prompt ${input.sessionID}`);
        if (sessions.get(input.sessionID)?.metadata?.opWorkflow) await api.prepareWorkflowPrompt(input.sessionID, input.id);
      },
      async move(input: { sessionID: string; directory: string }) {
        events.push(`move ${input.sessionID} ${input.directory}`);
        sessions.get(input.sessionID)!.location = { directory: input.directory };
      },
      async switchAgent(input: { sessionID: string; agent: string }) {
        events.push(`agent ${input.sessionID} ${input.agent}`);
        sessions.get(input.sessionID)!.agent = input.agent;
      },
      async interrupt(input: { sessionID: string }) {
        events.push(`interrupt ${input.sessionID}`);
      },
      async switchModel() {},
    },
    agent: {
      async get({ agentID, location }: { agentID: string; location: { directory: string } }) {
        agentLookups.push(agentID);
        const permissions = profiles[agentID];
        // OpenCode reports a configured agent as missing until a new location has loaded.
        if (location.directory === paths.worker && cold > 0) {
          cold--;
          throw new Error(`Agent not found: ${agentID}`);
        }
        if (!permissions) throw new Error(`Agent not found: ${agentID}`);
        const layered = Object.entries(layers)
          .filter(([directory]) => location.directory === directory || location.directory.startsWith(`${directory}/`))
          .flatMap(([, agents]) => agents[agentID] ?? []);
        return { data: { permissions: [...permissions, ...layered] } };
      },
    },
    storage: {
      async get(key: string) { return structuredClone(storage.get(key)); },
      async set(key: string, value: unknown) { storage.set(key, structuredClone(value)); },
      async remove(key: string) { storage.delete(key); },
      async scan({ prefix }: { prefix: string }) {
        return { entries: [...storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })), next: undefined };
      },
    },
  } as unknown as Pick<Plugin.Context, "session" | "agent" | "storage">;
  api = threads(ctx, 8);
  const runtime = { agent: "build", model: { providerID: "test", id: "model" } } as never;
  return { ...paths, api, coordinatorID, sessions, created, prompts, updates, events, agentLookups, layers, storage, runtime, profiles };
}

describe("managed workers with grants", () => {
  test("threads_spawn records resolved grants, allows the subtree, and keeps other directories on demand", async () => {
    const fixture = await fakeThreads({ coordinatorPermissions: [{ action: "external_directory", resource: "*", effect: "ask" }] });
    const request = { key: "granted", title: "Granted", directory: fixture.worker, task: "Read refs", agent: "writer", paths: [fixture.link] };
    const view = await fixture.api.spawn(fixture.coordinatorID, request, fixture.runtime);
    const [session] = fixture.created;
    const effective = [...fixture.profiles.writer, ...session.permissions];
    expect(session.metadata.opThreadsPaths).toEqual([fixture.refs]);
    expect(decide(effective, "external_directory", `${fixture.refs}/nested/*`)).toBe("allow");
    expect(decide(effective, "external_directory", `${fixture.other}/*`)).toBe("ask");
    expect(decide(effective, "threads_report", "*")).toBe("allow");
    expect(fixture.prompts[0].text).toContain(`granted directories when the task requires them: ${fixture.refs}.`);
    await fixture.api.spawn(fixture.coordinatorID, { ...request, paths: [fixture.refs] }, fixture.runtime);
    expect(fixture.created).toHaveLength(1);
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...request, paths: [fixture.other] }, fixture.runtime)).rejects.toThrow("different request");
    expect(view.workerID).toBe(workerIdentity(fixture.coordinatorID, "granted"));
  });

  test("a grant for a worker in a location that has not loaded its agents waits for the role", async () => {
    const fixture = await fakeThreads({ coldLookups: 2 });
    await fixture.api.spawn(fixture.coordinatorID, {
      key: "cold", title: "Cold", directory: fixture.worker, task: "Read refs", agent: "writer", paths: [fixture.refs],
    }, fixture.runtime);
    expect(fixture.agentLookups.filter((agent) => agent === "writer")).toHaveLength(3);
    expect(fixture.created[0].metadata.opThreadsPaths).toEqual([fixture.refs]);
  });

  test("invalid or blocked grants fail before a worker session or index entry exists", async () => {
    const fixture = await fakeThreads();
    const base = { title: "Blocked", directory: fixture.worker, task: "Read refs", agent: "writer" };
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "missing", paths: [join(fixture.directory, "missing")] }, fixture.runtime)).rejects.toThrow("existing directory");
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "root", paths: ["/"] }, fixture.runtime)).rejects.toThrow("filesystem root");
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "guarded", agent: "guarded", paths: [fixture.refs] }, fixture.runtime)).rejects.toThrow("explicit external_directory deny");
    expect(fixture.created).toHaveLength(0);
    expect([...fixture.storage.keys()]).toEqual([]);
  });

  test("an exact deny of a granted directory itself fails before a worker session or index entry exists", async () => {
    const fixture = await fakeThreads();
    const exact: Rule = { action: "external_directory", resource: fixture.refs, effect: "deny" };
    const blocked = `Granted path ${fixture.refs} is blocked by an explicit external_directory deny (${fixture.refs})`;
    const ownerID = Session.ID.make(fixture.coordinatorID);
    const base = { title: "Exact", directory: fixture.worker, task: "Read refs", paths: [fixture.refs] };
    const workflow = (key: string, agent: string, access: "read" | "write") => fixture.api.spawnWorkflow(fixture.coordinatorID,
      { ...base, key: `workflow:wfr_test:${key}`, agent }, fixture.runtime,
      { ownerID, runID: "wfr_test", stepKey: key, callerAgent: "build", access, granted: false, isolation: "shared" });
    fixture.profiles["root-guarded"] = [...defaults, exact];
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "role", agent: "root-guarded" }, fixture.runtime)).rejects.toThrow(blocked);
    for (const access of ["read", "write"] as const) await expect(workflow(`role-${access}`, "root-guarded", access)).rejects.toThrow(blocked);
    fixture.sessions.get(fixture.coordinatorID)!.permissions = [exact];
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "coordinator", agent: "writer" }, fixture.runtime)).rejects.toThrow(blocked);
    await expect(fixture.api.spawn(fixture.coordinatorID, { ...base, key: "inherited" }, fixture.runtime)).rejects.toThrow(blocked);
    for (const access of ["read", "write"] as const) await expect(workflow(`coordinator-${access}`, "writer", access)).rejects.toThrow(blocked);
    expect(fixture.created).toHaveLength(0);
    expect([...fixture.storage.keys()]).toEqual([]);
  });

  test("a role-selected worker without grants or inherited asks is created without loading its role", async () => {
    const fixture = await fakeThreads({ coordinatorPermissions: [{ action: "shell", resource: "*", effect: "ask" }] });
    await fixture.api.spawn(fixture.coordinatorID, { key: "plain", title: "Plain", directory: fixture.worker, task: "Work", agent: "missing-role" }, fixture.runtime);
    expect(fixture.agentLookups).toEqual(["build"]);
    expect(fixture.created[0].permissions).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "threads_report", resource: "*", effect: "allow" },
    ]);
    expect("opThreadsPaths" in fixture.created[0].metadata).toBe(false);
  });

  test("an inherited external ask stays an ask for role workers but cannot override the role's deny", async () => {
    const fixture = await fakeThreads({ coordinatorPermissions: [{ action: "external_directory", resource: "*", effect: "ask" }] });
    await fixture.api.spawn(fixture.coordinatorID, { key: "writer", title: "Writer", directory: fixture.worker, task: "Work", agent: "writer" }, fixture.runtime);
    await fixture.api.spawn(fixture.coordinatorID, { key: "reader", title: "Reader", directory: fixture.worker, task: "Work", agent: "reader" }, fixture.runtime);
    const writer = [...fixture.profiles.writer, ...fixture.created[0].permissions];
    const reader = [...fixture.profiles.reader, ...fixture.created[1].permissions];
    expect(decide(writer, "external_directory", `${fixture.refs}/*`)).toBe("ask");
    expect(decide(reader, "external_directory", `${fixture.refs}/*`)).toBe("deny");
  });

  test("workflow workers carry grants into creation and the read profile applied at first prompt", async () => {
    const fixture = await fakeThreads();
    const ownerID = Session.ID.make(fixture.coordinatorID);
    const workflow = (stepKey: string, access: "read" | "write") =>
      ({ ownerID, runID: "wfr_test", stepKey, callerAgent: "build", access, granted: false, isolation: "shared" as const });
    await fixture.api.spawnWorkflow(fixture.coordinatorID, {
      key: "workflow:wfr_test:write", title: "Write", directory: fixture.worker, task: "Write refs", agent: "writer", paths: [fixture.link],
    }, fixture.runtime, workflow("write", "write"));
    const write = fixture.created[0];
    const writeRules = [...fixture.profiles.writer, ...write.permissions];
    expect(write.metadata.opThreadsPaths).toEqual([fixture.refs]);
    expect(decide(writeRules, "external_directory", `${fixture.refs}/*`)).toBe("allow");
    expect(decide(writeRules, "external_directory", `${fixture.other}/*`)).toBe("ask");
    expect(decide(writeRules, "read", `${fixture.refs}/.env`)).toBe("deny");
    expect(fixture.prompts[0].text).toContain(`Work only in ${fixture.worker}. You may also use these granted directories`);

    await fixture.api.spawnWorkflow(fixture.coordinatorID, {
      key: "workflow:wfr_test:read", title: "Read", directory: fixture.worker, task: "Read refs", agent: "reader", paths: [fixture.refs],
    }, fixture.runtime, workflow("read", "read"));
    const read = fixture.updates.find((update) => update.sessionID === fixture.created[1].id)!;
    const readRules = [...fixture.profiles.reader, ...read.permissions];
    expect(decide(readRules, "external_directory", `${fixture.refs}/nested/*`)).toBe("allow");
    expect(decide(readRules, "read", `${fixture.refs}/file.txt`)).toBe("allow");
    expect(decide(readRules, "edit", `${fixture.refs}/file.txt`)).toBe("deny");
    expect(decide(readRules, "external_directory", `${fixture.other}/*`)).toBe("deny");
    await expect(fixture.api.spawnWorkflow(fixture.coordinatorID, {
      key: "workflow:wfr_test:write", title: "Write", directory: fixture.worker, task: "Write refs", agent: "writer", paths: [fixture.other],
    }, fixture.runtime, workflow("write", "write"))).rejects.toThrow("different request");
  });
});

describe("workflow workers at their destination", () => {
  // A worktree step reserves its worker at the source repository, then moves it into the checkout. The
  // role at the checkout adds rules from `<grant>/.opencode-workflows/`, which the source never sees.
  async function relocation(options: Parameters<typeof fakeThreads>[0] = {}) {
    const fixture = await fakeThreads(options);
    const grant = join(fixture.directory, "granted");
    const source = await repository(join(grant, "repository"));
    const checkout = join(grant, ".opencode-workflows", "checkout");
    git(source, "worktree", "add", "-q", "-b", "checkout", checkout);
    const ownerID = Session.ID.make(fixture.coordinatorID);
    const metadata = (key: string) => ({ ownerID, runID: "wfr_test", stepKey: key, callerAgent: "build", access: "write" as const });
    const request = (key: string, paths?: string[], directory = checkout) =>
      ({ key: `workflow:wfr_test:${key}`, title: key, directory, task: "Write", agent: "writer", ...(paths === undefined ? {} : { paths }) });
    return {
      ...fixture, grant, source, checkout,
      workerID: (key: string) => workerIdentity(fixture.coordinatorID, `workflow:wfr_test:${key}`),
      layer: (rules: Rule[]) => { fixture.layers[join(grant, ".opencode-workflows")] = { writer: rules }; },
      setCoordinatorPermissions: (rules: Rule[]) => { fixture.sessions.get(fixture.coordinatorID)!.permissions = rules; },
      reserve: (key: string, paths?: string[]) =>
        fixture.api.reserveWorkflow(fixture.coordinatorID, request(key, paths), source, fixture.runtime, metadata(key)),
      spawn: (key: string, granted: boolean, paths?: string[], isolation: "shared" | "worktree" = "worktree") =>
        fixture.api.spawnWorkflow(fixture.coordinatorID, request(key, paths, isolation === "worktree" ? checkout : source), fixture.runtime,
          { ...metadata(key), granted, isolation }),
    };
  }

  test("a reservation fails before it moves or is prompted when the role at its checkout denies a path that the checkout makes local", async () => {
    const fixture = await relocation();
    const deny: Rule = { action: "external_directory", resource: "*/.opencode-workflows/*/private/*", effect: "deny" };
    fixture.layer([deny]);
    await fixture.reserve("scope", [fixture.grant]);
    const workerID = fixture.workerID("scope");
    await expect(fixture.spawn("scope", true, [fixture.grant])).rejects.toThrow(
      `Workflow directory ${fixture.checkout} would make ${fixture.checkout} local to its worker, where the explicit external_directory deny (${deny.resource}) cannot apply`,
    );
    expect(fixture.events).toEqual([`interrupt ${workerID}`]);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.sessions.get(workerID)!.location.directory).toBe(fixture.source);
  });

  test("a reservation gets its permissions from the role at its checkout and the coordinator's current rules before its first prompt", async () => {
    const fixture = await relocation({ coordinatorPermissions: [{ action: "external_directory", resource: "*", effect: "ask" }] });
    const secret: Rule = { action: "external_directory", resource: `${fixture.grant}/secret/*`, effect: "deny" };
    fixture.layer([secret]);
    await fixture.reserve("refresh", [fixture.grant]);
    const workerID = fixture.workerID("refresh");
    const reservation: Rule[] = fixture.sessions.get(workerID)!.permissions;
    fixture.setCoordinatorPermissions([{ action: "external_directory", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }]);
    await fixture.spawn("refresh", true, [fixture.grant]);
    const destination = [...fixture.profiles.writer, secret];
    const stale = [...destination, ...reservation];
    const effective = [...destination, ...fixture.sessions.get(workerID)!.permissions];
    // The reservation's source-role rules put the grant after the checkout role's deny.
    expect(decide(stale, "external_directory", `${fixture.grant}/secret/*`)).toBe("allow");
    expect(decide(effective, "external_directory", `${fixture.grant}/secret/*`)).toBe("deny");
    expect(decide(effective, "external_directory", `${fixture.grant}/repository/*`)).toBe("allow");
    expect(decide(effective, "external_directory", `${fixture.other}/*`)).toBe("ask");
    expect(decide(stale, "shell", "ls")).toBe("allow");
    expect(decide(effective, "shell", "ls")).toBe("deny");
    expect(fixture.events).toEqual([
      `move ${workerID} ${fixture.checkout}`, `agent ${workerID} writer`, `update ${workerID}`, `prompt ${workerID}`,
    ]);
  });

  test("the coordinator's rules at the time of the first prompt decide the destination check", async () => {
    const fixture = await relocation();
    await fixture.reserve("current", [fixture.grant]);
    fixture.setCoordinatorPermissions([{ action: "external_directory", resource: `${fixture.grant}/.opencode-workflows/*`, effect: "deny" }]);
    await expect(fixture.spawn("current", true, [fixture.grant])).rejects.toThrow(`deny (${fixture.grant}/.opencode-workflows/*) cannot apply`);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.events).toEqual([`interrupt ${fixture.workerID("current")}`]);
  });

  test("a reservation in the owner's own project is refreshed at its checkout without a project check", async () => {
    const fixture = await relocation({ coordinatorPermissions: [{ action: "external_directory", resource: "*", effect: "ask" }] });
    const deny: Rule = { action: "external_directory", resource: "*/.opencode-workflows/*/private/*", effect: "deny" };
    fixture.layer([deny]);
    await fixture.reserve("owned");
    const workerID = fixture.workerID("owned");
    const reservation: Rule[] = fixture.sessions.get(workerID)!.permissions;
    await fixture.spawn("owned", false);
    const destination = [...fixture.profiles.writer, deny];
    const elsewhere = `${fixture.directory}/.opencode-workflows/other/private/*`;
    // The preserved ask follows the role's rules, so only recomputed rules reassert the checkout role's deny after it.
    expect(decide([...destination, ...reservation], "external_directory", elsewhere)).toBe("ask");
    expect(decide([...destination, ...fixture.sessions.get(workerID)!.permissions], "external_directory", elsewhere)).toBe("deny");
    expect(fixture.prompts.map((prompt) => prompt.sessionID)).toEqual([workerID]);
  });

  test("a new worker that only a grant admits is checked with the coordinator's current rules before its session exists", async () => {
    const fixture = await relocation();
    fixture.setCoordinatorPermissions([{ action: "external_directory", resource: `${fixture.source}/private/*`, effect: "deny" }]);
    await expect(fixture.spawn("fresh", true, [fixture.grant], "shared")).rejects.toThrow(`would make ${fixture.source} local to its worker`);
    expect(fixture.created).toHaveLength(0);
    expect([...fixture.storage.keys()]).toEqual([]);
    fixture.setCoordinatorPermissions([]);
    await fixture.spawn("fresh", true, [fixture.grant], "shared");
    expect(fixture.created.map((session) => session.location.directory)).toEqual([fixture.source]);
    expect(fixture.updates).toEqual([]);
  });
});
