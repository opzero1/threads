import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import type { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { recordedGrants, resolveGrantedPaths, withResolvedGrants } from "../src/external-access";
import { permissionMatches } from "../src/permissions";
import { threads, workerIdentity } from "../src/threads";
import { WorkflowAgentInput, type WorkflowRun } from "../src/workflow-types";
import { workflowSourceDirectory } from "../src/workflow-worker";

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
    expect(await workflowSourceDirectory(ctx(), run(project), step(join(refs, "nested"), [refs]))).toBe(join(refs, "nested"));
    expect(await workflowSourceDirectory(ctx(), run(project), step(refs, [refs]))).toBe(refs);
    await expect(workflowSourceDirectory(ctx(), run(project), step(other, [refs]))).rejects.toThrow("or a granted path");
    await expect(workflowSourceDirectory(ctx(), run(project), step(refs))).rejects.toThrow("inside the owner project");
    expect(await workflowSourceDirectory(ctx([refs]), run(project), step(refs))).toBe(refs);
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
  const agentLookups: string[] = [];
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
        sessions.get(input.sessionID)!.permissions = input.permissions;
      },
      async prompt(input: { sessionID: string; id: string; text: string }) {
        prompts.push(input);
        if (sessions.get(input.sessionID)?.metadata?.opWorkflow) await api.prepareWorkflowPrompt(input.sessionID, input.id);
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
        return { data: { permissions } };
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
  return { ...paths, api, coordinatorID, sessions, created, prompts, updates, agentLookups, storage, runtime, profiles };
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
    const workflow = (stepKey: string, access: "read" | "write") => ({ ownerID, runID: "wfr_test", stepKey, callerAgent: "build", access });
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
