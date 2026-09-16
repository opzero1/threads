import type { Permission } from "@opencode/schema/permission";

function matches(pattern: string, value: string) {
  const expression = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const normalized = value.replaceAll("\\", "/");
  const match = new RegExp(
    `^${expression}$`,
    process.platform === "win32" ? "is" : "s",
  ).exec(normalized);
  return match?.[0] === normalized;
}

export function delegationEffect(
  rules: Permission.Ruleset,
  agentID: string,
): Permission.Effect {
  return rules.findLast((rule) =>
    matches(rule.action, "subagent") && matches(rule.resource, agentID)
  )?.effect ?? "ask";
}

export function requireDelegation(rules: Permission.Ruleset, agentID: string) {
  if (delegationEffect(rules, agentID) !== "allow") {
    throw new Error(
      `Spawning agent "${agentID}" requires an explicit subagent allow for that agent ID; deny or ask cannot authorize managed spawning.`,
    );
  }
}
