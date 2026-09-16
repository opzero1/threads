import { expect, test } from "bun:test";
import { delegationEffect } from "../src/permissions";

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
