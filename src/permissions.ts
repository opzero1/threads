import type { Permission } from "@opencode/schema/permission";

export function permissionMatches(pattern: string, value: string) {
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

// Whether `pattern` matches `directory` or any path beneath it, under the rules of permissionMatches.
// It steps through the pattern one UTF-16 unit at a time, like the regular expression.
export function permissionReaches(pattern: string, directory: string) {
  const tokens = pattern.replaceAll("\\", "/");
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const expand = (positions: number[]) => {
    const reachable = new Set(positions);
    for (const position of reachable) if (tokens[position] === "*") reachable.add(position + 1);
    return reachable;
  };
  const advance = (positions: Set<number>, unit: string) => expand([...positions].flatMap((position) => {
    const token = tokens[position];
    if (token === "*") return [position];
    return token === "?" || (token !== undefined && fold(token) === fold(unit)) ? [position + 1] : [];
  }));
  let positions = expand([0]);
  for (const unit of directory.replaceAll("\\", "/").split("")) positions = advance(positions, unit);
  // Any position still live after `directory/` can finish on some path beneath it.
  return positions.has(tokens.length) || advance(positions, "/").size > 0;
}

export function delegationEffect(
  rules: Permission.Ruleset,
  agentID: string,
): Permission.Effect {
  return rules.findLast((rule) =>
    permissionMatches(rule.action, "subagent") && permissionMatches(rule.resource, agentID)
  )?.effect ?? "ask";
}

export function requireDelegation(rules: Permission.Ruleset, agentID: string) {
  if (delegationEffect(rules, agentID) !== "allow") {
    throw new Error(
      `Spawning agent "${agentID}" requires an explicit subagent allow for that agent ID; deny or ask cannot authorize managed spawning.`,
    );
  }
}
