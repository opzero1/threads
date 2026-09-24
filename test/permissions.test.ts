import { expect, test } from "bun:test";
import { delegationEffect, permissionMatches } from "../src/permissions";
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

test("agent-ID matching is whole-value and regex punctuation is literal", () => {
  const rules = [
    { action: "subagent", resource: "team/reviewer.v2", effect: "deny" },
  ] satisfies Parameters<typeof delegationEffect>[0];
  expect(delegationEffect(rules, "team/reviewer.v2")).toBe("deny");
  expect(delegationEffect(rules, "team/reviewerXv2")).toBe("ask");
  expect(delegationEffect(rules, "other/team/reviewer.v2")).toBe("ask");
});

test("read workers retain profile grants without overriding explicit caller denials", () => {
  const readProfile = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "/Users/fixture/reference/*", effect: "allow" },
  ] satisfies Parameters<typeof workflowPermissions>[1];
  const effect = (rules: ReturnType<typeof workflowPermissions>, resource: string) =>
    rules.findLast((rule) => permissionMatches(rule.action, "external_directory") && permissionMatches(rule.resource, resource))?.effect;
  const allowed = "/Users/fixture/reference/source.ts";
  const inherited = [{ action: "external_directory", resource: "*", effect: "ask" }] satisfies Parameters<typeof workflowPermissions>[0];
  expect(effect(workflowPermissions(inherited, readProfile), allowed)).toBe("allow");
  expect(effect(workflowPermissions(inherited, readProfile), "/Users/fixture/other/source.ts")).toBe("deny");
  expect(effect(workflowPermissions([...inherited, { action: "external_directory", resource: allowed, effect: "deny" }], readProfile), allowed)).toBe("deny");
  expect(effect(workflowPermissions(inherited), allowed)).toBe("deny");
});
