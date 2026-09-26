import { describe, expect, test } from "bun:test";
import type { Permission } from "@opencode/schema/permission";
import { assertGrantsReachable, grantAccess, workerRestrictions } from "../src/external-access";
import { delegationEffect, permissionMatches, permissionReaches } from "../src/permissions";
import { workflowPermissions } from "../src/threads";

test("named delegation follows ordered action and agent-ID wildcards", () => {
  const rules = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "sub*", resource: "vera-*", effect: "deny" },
    { action: "subagent", resource: "vera-cor?", effect: "ask" },
    { action: "subagent", resource: "vera-core", effect: "allow" },
  ] satisfies Parameters<typeof delegationEffect>[0];
  expect(delegationEffect(rules, "vera-reader")).toBe("deny");
  expect(delegationEffect(rules, "vera-cord")).toBe("ask");
  expect(delegationEffect(rules, "vera-core")).toBe("allow");
  expect(delegationEffect(rules, "general")).toBe("allow");
  expect(delegationEffect([], "vera-core")).toBe("ask");
});

test("a pattern reaches a directory when it matches the directory or a path beneath it", () => {
  const root = "/work/refs";
  for (const pattern of ["*", "/work/*", "/work/refs", "/work/refs/*", "/work/refs/private/*", "*/private/*", "/work/r?fs/*", "*refs*", "\\work\\refs\\*", "/work/re*/x", "/work/*/private"]) {
    expect({ pattern, reaches: permissionReaches(pattern, root) }).toEqual({ pattern, reaches: true });
  }
  for (const pattern of ["/work/refs-other/*", "/work/ref", "/work/refsX/*", "/elsewhere/*", "/work", "work/refs/*"]) {
    expect({ pattern, reaches: permissionReaches(pattern, root) }).toEqual({ pattern, reaches: false });
  }
  // Reaching patterns match a real value at or beneath the root; the others match none of these.
  expect(permissionMatches("/work/re*/x", `${root}/x`)).toBe(true);
  expect(permissionMatches("/work/*/private", `${root}/private`)).toBe(true);
  for (const value of [root, `${root}/*`, `${root}/private/*`, `${root}/x`]) {
    for (const pattern of ["/work/refs-other/*", "/work/ref", "/work/refsX/*", "/work", "work/refs/*"]) expect(permissionMatches(pattern, value)).toBe(false);
  }
});

test("agent-ID matching is whole-value and regex punctuation is literal", () => {
  const rules = [
    { action: "subagent", resource: "team/reviewer.v2", effect: "deny" },
  ] satisfies Parameters<typeof delegationEffect>[0];
  expect(delegationEffect(rules, "team/reviewer.v2")).toBe("deny");
  expect(delegationEffect(rules, "team/reviewerXv2")).toBe("ask");
  expect(delegationEffect(rules, "other/team/reviewer.v2")).toBe("ask");
});

type Rule = Permission.Rule;
// OpenCode evaluates the agent's rules followed by the session's rules; the last match wins.
const decide = (role: readonly Rule[], session: readonly Rule[], action: string, resource: string) =>
  [...role, ...session].findLast((rule) => permissionMatches(rule.action, action) && permissionMatches(rule.resource, resource))?.effect ?? "ask";
const ext = (resource: string) => ["external_directory", resource] as const;
// OpenCode's built-in agent defaults, as reported by /api/agent on 2.0.16.
const defaults: Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "/data/opencode/tool-output/*", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
];
const permissive: Rule[] = [...defaults, { action: "*", resource: "*", effect: "allow" }];
const readOnly: Rule[] = [
  ...defaults,
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
];
const refs = "/work/refs";

// The 0.2.4 implementation, kept to prove grant-free workers are unchanged.
function legacyWorkflowPermissions(inherited: readonly Rule[], readProfile?: readonly Rule[]): Rule[] {
  const readActions = ["read", "glob", "grep", "webfetch", "websearch", "skill", "external_directory"];
  return [
    ...(readProfile === undefined ? [] : [
      { action: "*", resource: "*", effect: "deny" as const },
      ...inherited.filter((rule) => rule.effect === "ask").map((rule) => ({ ...rule, effect: "deny" as const })),
      ...readProfile.flatMap((rule) => readActions.filter((action) => permissionMatches(rule.action, action)).map((action) => ({ ...rule, action }))),
    ]),
    ...inherited.filter((rule) => readProfile === undefined ? rule.effect !== "allow" : rule.effect === "deny")
      .map((rule) => ({ ...rule, effect: "deny" as const })),
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "threads_*", resource: "*", effect: "deny" },
    { action: "workflows_*", resource: "*", effect: "deny" },
    { action: "workflows_result", resource: "*", effect: "allow" },
  ];
}

describe("workflow worker permissions", () => {
  test("read workers retain profile grants without overriding explicit caller denials", () => {
    const readProfile: Rule[] = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "/Users/fixture/reference/*", effect: "allow" },
    ];
    const allowed = "/Users/fixture/reference/*";
    const inherited: Rule[] = [{ action: "external_directory", resource: "*", effect: "ask" }];
    const read = (rules: Rule[]) => workflowPermissions(rules, { access: "read", role: readProfile });
    expect(decide(readProfile, read(inherited), ...ext(allowed))).toBe("allow");
    expect(decide(readProfile, read(inherited), ...ext("/Users/fixture/other/*"))).toBe("deny");
    expect(decide(readProfile, read([...inherited, { action: "external_directory", resource: allowed, effect: "deny" }]), ...ext(allowed))).toBe("deny");
  });

  test("grant-free read workers and write workers without an external ask keep the 0.2.4 rules", () => {
    const inherited: Rule[] = [...defaults, { action: "shell", resource: "rm *", effect: "deny" }, { action: "edit", resource: "*.lock", effect: "ask" }];
    for (const role of [permissive, readOnly, []]) {
      expect(workflowPermissions(inherited, { access: "read", role })).toEqual(legacyWorkflowPermissions(inherited, role));
    }
    const noExternalAsk = inherited.filter((rule) => rule.action !== "external_directory");
    expect(workflowPermissions(noExternalAsk, { access: "write", role: permissive })).toEqual(legacyWorkflowPermissions(noExternalAsk));
  });

  test("an inherited external_directory ask stays an ask while other inherited asks become denies", () => {
    const inherited: Rule[] = [...defaults, { action: "shell", resource: "*", effect: "ask" }];
    const session = workflowPermissions(inherited, { access: "write", role: permissive });
    expect(legacyWorkflowPermissions(inherited)).toContainEqual({ action: "external_directory", resource: "*", effect: "deny" });
    expect(decide(permissive, session, ...ext("/outside/*"))).toBe("ask");
    expect(decide(permissive, session, "read", "/project/.env")).toBe("deny");
    expect(decide(permissive, session, "shell", "ls")).toBe("deny");
    expect(decide(permissive, session, "edit", "/project/src/a.ts")).toBe("allow");
    expect(decide(permissive, session, "threads_spawn", "*")).toBe("deny");
    expect(decide(permissive, session, "workflows_result", "*")).toBe("allow");
  });

  test("a catch-all inherited ask keeps asking only for external directories", () => {
    const session = workflowPermissions([{ action: "*", resource: "*", effect: "ask" }], { access: "write", role: permissive });
    expect(decide(permissive, session, ...ext("/outside/*"))).toBe("ask");
    expect(decide(permissive, session, "shell", "ls")).toBe("deny");
    expect(decide(permissive, session, "read", "/project/a.ts")).toBe("deny");
  });

  test("directories that the coordinator and the role both allow stay allowed next to a preserved ask", () => {
    const toolOutput = "/data/opencode/tool-output/*";
    const session = workflowPermissions(defaults, { access: "write", role: permissive });
    expect(decide(permissive, legacyWorkflowPermissions(defaults), ...ext(toolOutput))).toBe("deny");
    expect(decide(permissive, session, ...ext(toolOutput))).toBe("allow");
    expect(decide(permissive, session, ...ext("/outside/*"))).toBe("ask");
    const coordinatorOnly: Rule[] = [...defaults, { action: "external_directory", resource: "/coordinator-only/*", effect: "allow" }];
    expect(decide(permissive, workflowPermissions(coordinatorOnly, { access: "write", role: permissive }), ...ext("/coordinator-only/*"))).toBe("ask");
    const askedAfter: Rule[] = [...defaults, { action: "external_directory", resource: "*", effect: "ask" }];
    expect(decide(permissive, workflowPermissions(askedAfter, { access: "write", role: permissive }), ...ext(toolOutput))).toBe("ask");
    const deniedByRole: Rule[] = [...defaults, { action: "external_directory", resource: "/data/*", effect: "deny" }];
    expect(decide(deniedByRole, workflowPermissions(defaults, { access: "write", role: deniedByRole }), ...ext(toolOutput))).toBe("deny");
    expect(decide(readOnly, workflowPermissions(defaults, { access: "write", role: readOnly }), ...ext(toolOutput))).toBe("deny");
  });

  test("a preserved ask cannot weaken the role's own external_directory denies", () => {
    const explicit: Rule[] = [...permissive, { action: "external_directory", resource: "/secret/*", effect: "deny" }];
    const explicitSession = workerRestrictions(defaults, explicit);
    expect(decide(explicit, explicitSession, ...ext("/secret/*"))).toBe("deny");
    expect(decide(explicit, explicitSession, ...ext("/other/*"))).toBe("ask");
    expect(decide(readOnly, workerRestrictions(defaults, readOnly), ...ext("/other/*"))).toBe("deny");
    expect(workerRestrictions([{ action: "shell", resource: "*", effect: "ask" }], readOnly))
      .toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
  });
});

describe("coordinator grants", () => {
  test("a grant covers the directory and its subtree but not siblings or parents", () => {
    const session = workflowPermissions(defaults, { access: "write", role: permissive, paths: [refs] });
    expect(decide(permissive, session, ...ext(refs))).toBe("allow");
    expect(decide(permissive, session, ...ext(`${refs}/*`))).toBe("allow");
    expect(decide(permissive, session, ...ext(`${refs}/deep/nested/*`))).toBe("allow");
    expect(decide(permissive, session, ...ext("/work/refs-other/*"))).toBe("ask");
    expect(decide(permissive, session, ...ext("/work/*"))).toBe("ask");
    expect(() => assertGrantsReachable([...permissive, ...session], [refs])).not.toThrow();
  });

  test("a grant overrides a read-only role's catch-all deny without giving edit or shell", () => {
    const session = workflowPermissions(defaults, { access: "read", role: readOnly, paths: [refs] });
    expect(decide(readOnly, session, ...ext(`${refs}/src/*`))).toBe("allow");
    expect(decide(readOnly, session, "read", `${refs}/src/a.ts`)).toBe("allow");
    expect(decide(readOnly, session, "edit", `${refs}/src/a.ts`)).toBe("deny");
    expect(decide(readOnly, session, "shell", "ls")).toBe("deny");
    expect(decide(readOnly, session, ...ext("/elsewhere/*"))).toBe("deny");
    const broad = workflowPermissions(defaults, { access: "read", role: permissive, paths: [refs] });
    expect(decide(permissive, broad, "edit", `${refs}/a.ts`)).toBe("deny");
    expect(decide(permissive, broad, "shell", "ls")).toBe("deny");
    expect(decide(permissive, broad, "workflows_start", "*")).toBe("deny");
    const managed = [...workerRestrictions(defaults, readOnly), ...grantAccess(defaults, readOnly, [refs])];
    expect(decide(readOnly, managed, ...ext(`${refs}/*`))).toBe("allow");
    expect(decide(readOnly, managed, "edit", `${refs}/a.ts`)).toBe("deny");
  });

  test("explicit coordinator and role denies still win inside a grant", () => {
    const inherited: Rule[] = [
      ...defaults,
      { action: "external_directory", resource: `${refs}/private/*`, effect: "deny" },
      { action: "read", resource: "*.pem", effect: "deny" },
    ];
    const role: Rule[] = [...permissive, { action: "external_directory", resource: "*/secret/*", effect: "deny" }];
    for (const access of ["read", "write"] as const) {
      const session = workflowPermissions(inherited, { access, role, paths: [refs] });
      expect(decide(role, session, ...ext(`${refs}/*`))).toBe("allow");
      expect(decide(role, session, ...ext(`${refs}/private/*`))).toBe("deny");
      expect(decide(role, session, ...ext(`${refs}/private/deeper/*`))).toBe("deny");
      expect(decide(role, session, ...ext(`${refs}/lib/secret/*`))).toBe("deny");
      expect(decide(role, session, "read", `${refs}/key.pem`)).toBe("deny");
    }
    const write = workflowPermissions(inherited, { access: "write", role, paths: [refs] });
    expect(decide(role, write, "read", `${refs}/.env`)).toBe("deny");
  });

  test("a grant whose directory an explicit deny blocks is rejected", () => {
    const closed: Rule[] = [...defaults, { action: "external_directory", resource: "*", effect: "deny" }];
    const blocked = workflowPermissions(closed, { access: "write", role: permissive, paths: [refs] });
    expect(() => assertGrantsReachable([...permissive, ...blocked], [refs])).toThrow("explicit external_directory deny (*)");
    const guarded: Rule[] = [...permissive, { action: "external_directory", resource: "/work/*", effect: "deny" }];
    const denied = workflowPermissions(defaults, { access: "write", role: guarded, paths: [refs] });
    expect(() => assertGrantsReachable([...guarded, ...denied], [refs])).toThrow("explicit external_directory deny (/work/*)");
    const baseline = workflowPermissions([...defaults, { action: "*", resource: "*", effect: "deny" }], { access: "read", role: readOnly, paths: [refs] });
    expect(() => assertGrantsReachable([...readOnly, ...baseline], [refs])).not.toThrow();
  });

  test("an exact deny of the granted directory itself is rejected for the coordinator and the role", () => {
    const exact: Rule = { action: "external_directory", resource: refs, effect: "deny" };
    const guarded: Rule[] = [...permissive, exact];
    for (const access of ["read", "write"] as const) {
      const coordinator = workflowPermissions([...defaults, exact], { access, role: permissive, paths: [refs] });
      expect(decide(permissive, coordinator, ...ext(`${refs}/*`))).toBe("allow");
      expect(() => assertGrantsReachable([...permissive, ...coordinator], [refs])).toThrow(`explicit external_directory deny (${refs})`);
      const role = workflowPermissions(defaults, { access, role: guarded, paths: [refs] });
      expect(() => assertGrantsReachable([...guarded, ...role], [refs])).toThrow(`explicit external_directory deny (${refs})`);
    }
    const pattern: Rule = { action: "external_directory", resource: "*/refs", effect: "deny" };
    const managed = [...workerRestrictions(defaults, permissive), ...grantAccess([...defaults, pattern], permissive, [refs])];
    expect(() => assertGrantsReachable([...permissive, ...managed], [refs])).toThrow("explicit external_directory deny (*/refs)");
    const managedRole = [...workerRestrictions(defaults, guarded), ...grantAccess(defaults, guarded, [refs])];
    expect(() => assertGrantsReachable([...guarded, ...managedRole], [refs])).toThrow(`explicit external_directory deny (${refs})`);
    const inner: Rule = { action: "external_directory", resource: `${refs}/private`, effect: "deny" };
    const usable = workflowPermissions([...defaults, inner], { access: "write", role: permissive, paths: [refs] });
    expect(() => assertGrantsReachable([...permissive, ...usable], [refs])).not.toThrow();
  });

  test("workers cannot widen grants through their own rules", () => {
    const session = workflowPermissions(defaults, { access: "write", role: permissive, paths: [refs] });
    for (const action of ["threads_spawn", "workflows_start", "workflows_control", "subagent"]) {
      expect(decide(permissive, session, action, "*")).toBe("deny");
    }
    expect(grantAccess(defaults, permissive, undefined)).toEqual([]);
    expect(grantAccess(defaults, permissive, [])).toEqual([]);
  });
});
