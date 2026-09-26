import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Permission } from "@opencode/schema/permission";
import { z } from "zod";
import { permissionMatches } from "./permissions";

export const EXTERNAL_DIRECTORY = "external_directory";
export const GRANTS_METADATA = "opThreadsPaths";

const external = (resource: string, effect: Permission.Effect): Permission.Rule => ({ action: EXTERNAL_DIRECTORY, resource, effect });
const governsExternal = (rule: Permission.Rule) => permissionMatches(rule.action, EXTERNAL_DIRECTORY);
const wildcard = (pattern: string) => /^\*+$/.test(pattern);

// Returns undefined when nothing is granted, so grant-free requests keep their existing fingerprints.
export async function resolveGrantedPaths(paths: readonly string[] | undefined): Promise<string[] | undefined> {
  if (paths === undefined || paths.length === 0) return undefined;
  const resolved = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Granted path must be absolute: ${path}`);
    const real = await realpath(path).catch(() => undefined);
    const directory = real !== undefined && await stat(real).then((entry) => entry.isDirectory(), () => false);
    if (real === undefined || !directory) throw new Error(`Granted path must be an existing directory: ${path}`);
    if (dirname(real) === real) throw new Error(`Granted path cannot be a filesystem root: ${path}`);
    // Permission patterns read * and ? as wildcards and normalize backslashes, which would widen the grant.
    if (/[*?]/.test(real) || (process.platform !== "win32" && real.includes("\\"))) {
      throw new Error(`Granted path contains a character that permission patterns cannot match literally: ${real}`);
    }
    resolved.add(real);
  }
  return [...resolved].sort();
}

export async function withResolvedGrants<T extends { paths?: string[] }>(input: T): Promise<T> {
  const paths = await resolveGrantedPaths(input.paths);
  const { paths: _, ...rest } = input;
  return (paths === undefined ? rest : { ...rest, paths }) as T;
}

export function recordedGrants(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[GRANTS_METADATA];
  return value === undefined ? undefined : z.array(z.string().min(1)).min(1).parse(value);
}

export function grantNotice(paths: readonly string[] | undefined) {
  return paths === undefined || paths.length === 0
    ? ""
    : ` You may also use these granted directories when the task requires them: ${paths.join(", ")}.`;
}

export function asksExternal(rules: Permission.Ruleset) {
  return rules.some((rule) => rule.effect === "ask" && governsExternal(rule));
}

// Allows are dropped and other inherited rules become denies, except that an external_directory ask
// stays an ask so the user can approve on-demand access in the worker's own tab. An external_directory
// allow in `shared` keeps its place in the inherited order.
function inheritedRestrictions(inherited: Permission.Ruleset, shared: ReadonlySet<string> = new Set()): Permission.Rule[] {
  return inherited.flatMap((rule): Permission.Rule[] => {
    if (rule.effect === "allow") return rule.action === EXTERNAL_DIRECTORY && shared.has(rule.resource) ? [rule] : [];
    const denied: Permission.Rule = { ...rule, effect: "deny" };
    if (rule.effect !== "ask" || !governsExternal(rule)) return [denied];
    const asked = external(rule.resource, "ask");
    return rule.action === EXTERNAL_DIRECTORY ? [asked] : [denied, asked];
  });
}

// Session rules follow the role's rules, so a preserved ask would override the role's own
// external_directory rules. Directories that the coordinator and the role both allow by the same rule,
// such as OpenCode's tool-output and configuration directories, stay allowed; the role's denies,
// including a catch-all deny, are reasserted after the ask.
export function workerRestrictions(inherited: Permission.Ruleset, role: Permission.Ruleset): Permission.Rule[] {
  if (!asksExternal(inherited)) return inheritedRestrictions(inherited);
  const shared = new Set(role
    .filter((rule) => rule.effect === "allow" && rule.action === EXTERNAL_DIRECTORY && !wildcard(rule.resource))
    .map((rule) => rule.resource));
  return [
    ...inheritedRestrictions(inherited, shared),
    ...role.filter((rule) => rule.effect === "deny" && governsExternal(rule)).map((rule) => external(rule.resource, "deny")),
  ];
}

// A catch-all `* *` deny is a baseline that grants override. Any other external_directory deny from
// the coordinator or the role is explicit.
export function explicitDenies(inherited: Permission.Ruleset, role: Permission.Ruleset) {
  return [...inherited, ...role].filter((rule) =>
    rule.effect === "deny" && governsExternal(rule) && !(wildcard(rule.action) && wildcard(rule.resource)));
}

// Grants follow every restriction so they win over asks and catch-all baselines. Explicit denies are
// reasserted after them and still win.
export function grantAccess(inherited: Permission.Ruleset, role: Permission.Ruleset, paths: readonly string[] | undefined): Permission.Rule[] {
  if (paths === undefined || paths.length === 0) return [];
  return [
    ...paths.flatMap((path) => [external(path, "allow"), external(`${path}/*`, "allow")]),
    ...explicitDenies(inherited, role).map((rule) => external(rule.resource, "deny")),
  ];
}

// `rules` are the worker's effective rules: its role's rules followed by its session rules. A grant
// covers its directory and its subtree, so a deny of either one blocks it.
export function assertGrantsReachable(rules: Permission.Ruleset, paths: readonly string[] | undefined) {
  for (const path of paths ?? []) {
    for (const resource of [path, `${path}/*`]) {
      const decision = rules.findLast((rule) => governsExternal(rule) && permissionMatches(rule.resource, resource));
      if (decision?.effect !== "allow") {
        throw new Error(`Granted path ${path} is blocked by an explicit external_directory deny (${decision?.resource ?? "no matching rule"})`);
      }
    }
  }
}

// OpenCode skips external_directory checks inside a session's project: the git worktree that git
// finds from its Location, or the Location itself outside a repository. This returns that directory
// or a wider one, never a narrower one. A `.git` file ends the search because git either uses it or
// fails. A `.git` directory ends it only if it looks valid, because git skips an invalid one.
export async function projectRoot(directory: string) {
  for (let current = directory; ; current = dirname(current)) {
    const marker = join(current, ".git");
    const entry = await stat(marker).catch(() => undefined);
    if (entry?.isFile() || (entry?.isDirectory() && await repositoryMarker(marker))) return current;
    if (dirname(current) === current) return directory;
  }
}

// A stricter form of git's own check: a symbolic or hexadecimal HEAD that is not a symlink, plus
// searchable `objects` and `refs`.
async function repositoryMarker(marker: string) {
  const head = join(marker, "HEAD");
  if (!await lstat(head).then((entry) => entry.isFile(), () => false)) return false;
  const content = await readFile(head, "utf8").catch(() => "");
  const searchable = await Promise.all(["objects", "refs"].map((name) =>
    access(join(marker, name), constants.X_OK).then(() => true, () => false)));
  return /^(?:ref:\s*refs\/|[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$)/.test(content) && searchable.every(Boolean);
}
