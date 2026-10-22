import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { requireOpenCode21 } from "../src/opencode-compat";
import { workflows, workflowStartPermission, type WorkflowStartPermission } from "../src/workflows";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const tool = { sessionID: "ses_owner", agent: "build", messageID: "msg_start", id: "call_start" } as const;
const script = 'export const meta = {name:"inline",description:"Inline"}; return args;';

test("an inline script asks for the wildcard resource and offers no always reply", () => {
  expect(workflowStartPermission({ key: "audit-1" }, tool as never)).toEqual({
    sessionID: "ses_owner",
    agent: "build",
    action: "workflows_start",
    resources: ["*"],
    metadata: { description: "Start an inline workflow script with key audit-1", key: "audit-1" },
    source: { type: "tool", messageID: "msg_start", id: "call_start" },
  });
});

test("a saved workflow asks for its name and records resumeFrom without save patterns", () => {
  const request = workflowStartPermission({ key: "audit-2", name: "audit", resumeFrom: "wf_prior" }, tool as never);
  expect(request.resources).toEqual(["audit"]);
  expect(request.save).toBeUndefined();
  expect(request.metadata).toEqual({
    description: "Start saved workflow audit with key audit-2, reusing completed steps of wf_prior",
    key: "audit-2", name: "audit", resumeFrom: "wf_prior",
  });
});

test("Threads refuses OpenCode releases before 2.1 and loads on 2.1 and later", () => {
  for (const version of ["2.0.28", "2.0.32", "1.9.0"]) expect(() => requireOpenCode21(version)).toThrow("requires OpenCode 2.1");
  for (const version of ["2.1.0", "2.1.2", "2.2.0", "3.0.0", "2.1.3-beta.1", "0.0.0-dev", "local", undefined]) expect(() => requireOpenCode21(version)).not.toThrow();
});

async function harness(assert: (input: WorkflowStartPermission) => Promise<void>) {
  await mkdir(join(import.meta.dir, "../.audit"), { recursive: true });
  const root = await mkdtemp(join(import.meta.dir, "../.audit/start-permission-"));
  paths.push(root);
  const events: string[] = [];
  const asked: WorkflowStartPermission[] = [];
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>();
  const reached = new Error("engine.start reached session lookup");
  const ctx = {
    options: {},
    location: { directory: root, project: { canonical: root } },
    storage: {
      get: async () => undefined,
      set: async (key: string) => { events.push(`storage.set:${key}`); },
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    session: {
      hook: async () => {},
      get: async () => { events.push("session.get"); throw reached; },
    },
    permission: {
      assert: async (input: WorkflowStartPermission) => { events.push("permission.assert"); asked.push(input); await assert(input); },
    },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    tool: {
      transform: async (register: (editor: unknown) => void) => register({
        namespace: () => {},
        add: (definition: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }) => { tools.set(definition.name, definition); },
      }),
      hook: async () => ({ dispose: async () => {} }),
    },
    skill: { transform: async () => {} },
    command: { transform: async () => {}, reload: async () => {} },
  } as unknown as Plugin.Context;
  const models = new Map([[tool.sessionID, { providerID: "fixture", modelID: "fixture" }]]) as never;
  const dispose = await workflows(ctx, {} as never, models, 1);
  const start = tools.get("start");
  if (!start) throw new Error("workflows_start not registered");
  events.length = 0;
  const call = (input: unknown) => start.execute(input, { ...tool, signal: new AbortController().signal, progress: async () => {} });
  return { call, events, asked, reached, dispose };
}

test("a rejected or denied permission leaves workflows_start before any engine work", async () => {
  const declined = new Error("Permission denied: workflows_start");
  const run = await harness(async () => { throw declined; });
  try {
    await expect(run.call({ key: "denied", script })).rejects.toBe(declined);
    expect(run.events).toEqual(["permission.assert"]);
    expect(run.asked[0]?.resources).toEqual(["*"]);
  } finally { await run.dispose(); }
});

test("an allowed start reaches the engine only after the permission check, and every retry asks again", async () => {
  const run = await harness(async () => {});
  try {
    const input = { key: "same-key", script };
    await expect(run.call(input)).rejects.toBe(run.reached);
    await expect(run.call(input)).rejects.toBe(run.reached);
    expect(run.events.filter((event) => !event.startsWith("storage."))).toEqual(["permission.assert", "session.get", "permission.assert", "session.get"]);
    expect(run.asked.map((request) => request.metadata?.key)).toEqual(["same-key", "same-key"]);
  } finally { await run.dispose(); }
});

test("invalid input fails before a permission prompt", async () => {
  const run = await harness(async () => {});
  try {
    await expect(run.call({ key: "both", script, name: "audit" })).rejects.toThrow();
    expect(run.events).toEqual([]);
  } finally { await run.dispose(); }
});
