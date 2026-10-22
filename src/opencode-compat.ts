// Unrecognized versions, such as development builds, load: workflows_start still fails closed
// there, because a host without permission.assert rejects before a run is created.
export function requireOpenCode21(version: string | undefined) {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version ?? "");
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 || major > 2 || (major === 2 && minor >= 1)) return;
  throw new Error(`Threads requires OpenCode 2.1 or later; this is OpenCode ${version}. Use Threads 0.3.2 with OpenCode 2.0.28.`);
}
