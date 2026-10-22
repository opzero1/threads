import { expect, test as bunTest } from "bun:test";
import { mkdir, readFile, writeFile, lstat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const test = process.platform === "darwin" ? bunTest : bunTest.skip;
const receipt = join(root, ".audit/recovery/heartbeat", `installer-${randomUUID()}`);
await mkdir(receipt, { recursive: true });
const built = await Bun.build({ entrypoints: [join(root, "scripts/heartbeat-cli.ts")], outdir: receipt, naming: "runner.mjs", target: "node", packages: "external" });
if (!built.success) throw new Error(built.logs.join("\n"));
const runner = join(receipt, "runner.mjs");
const hashes = Object.fromEntries(await Promise.all(["src/heartbeat-runner.ts", "test/heartbeat-installer.test.ts", "test/heartbeat-runner.test.ts"].map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
await writeFile(join(receipt, "hashes.json"), JSON.stringify(hashes, null, 2));
console.log(`Installer evidence: ${receipt}`);
const domain = `gui/${process.getuid!()}`;

async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { args, code, stdout, stderr };
}

async function fixture() {
  const dir = join(receipt, randomUUID());
  const host = join(dir, "host"), agents = join(dir, "agents");
  await mkdir(host, { recursive: true }); await mkdir(agents);
  const label = `com.opthreads.heartbeat.test-${randomUUID()}`;
  const config = join(dir, "config.json"), plist = join(agents, `${label}.plist`);
  const commands: Awaited<ReturnType<typeof command>>[] = [];
  let snapshotHook = async () => {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    if (new URL(request.url).pathname.endsWith("/snapshot")) {
      await snapshotHook(); snapshotHook = async () => {};
      return Response.json({ output: { protocol: 1, entries: [] } });
    }
    return new Response("Unexpected fixture request", { status: 500 });
  } });
  const service = join(dir, "service.json");
  await writeFile(service, JSON.stringify({ url: server.url.toString(), pid: process.pid, version: "2.1.1" }));
  async function run(args: string[]) { const result = await command(args); commands.push(result); await writeFile(join(dir, "commands.json"), JSON.stringify(commands, null, 2)); return result; }
  const ctl = (...args: string[]) => run(["/bin/launchctl", ...args]);
  const cli = (...args: string[]) => run(["node", runner, ...args, "--config", config]);
  const install = () => cli("install", "--service-file", service, "--host-directory", host, "--label", label, "--launchagents-directory", agents);
  async function foreign() {
    const path = join(dir, "foreign.plist");
    await writeFile(path, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>300</string></array><key>RunAtLoad</key><true/></dict></plist>`);
    expect((await ctl("bootstrap", domain, path)).code).toBe(0);
    for (let i = 0; i < 100; i++) { const printed = await ctl("print", `${domain}/${label}`); if (/pid = \d+/.test(printed.stdout)) return printed.stdout.match(/pid = (\d+)/)![1]; await Bun.sleep(50); }
    throw new Error("Foreign fixture never ran");
  }
  return { dir, config, plist, label, ctl, cli, install, foreign, hook(fn: () => Promise<void>) { snapshotHook = fn; }, async close() {
    await ctl("bootout", `${domain}/${label}`); await ctl("enable", `${domain}/${label}`);
    expect((await ctl("print", `${domain}/${label}`)).code).not.toBe(0);
    await server.stop(true);
  } };
}

test("installer preserves preexisting plist bytes on fresh config collision", async () => {
  const f = await fixture();
  try { await writeFile(f.plist, "preexisting plist bytes\n"); expect((await f.install()).code).not.toBe(0); expect(await readFile(f.plist, "utf8")).toBe("preexisting plist bytes\n"); expect(await Bun.file(f.config).exists()).toBe(false); }
  finally { await f.close(); }
});

test("installer refuses occupied config including dangling symlink", async () => {
  const f = await fixture();
  try { await symlink(join(f.dir, "missing"), f.config); expect((await f.install()).code).not.toBe(0); expect((await lstat(f.config)).isSymbolicLink()).toBe(true); expect(await Bun.file(f.plist).exists()).toBe(false); }
  finally { await f.close(); }
});

test("installer preserves occupied config bytes and concurrent config winner", async () => {
  const occupied = await fixture();
  try { await writeFile(occupied.config, "existing config\n"); expect((await occupied.install()).code).not.toBe(0); expect(await readFile(occupied.config, "utf8")).toBe("existing config\n"); }
  finally { await occupied.close(); }
  const race = await fixture();
  try { race.hook(() => writeFile(race.config, "concurrent config\n")); expect((await race.install()).code).not.toBe(0); expect(await readFile(race.config, "utf8")).toBe("concurrent config\n"); expect(await Bun.file(race.plist).exists()).toBe(false); }
  finally { await race.close(); }
});

test("installer preserves loaded same-label foreign job and PID", async () => {
  const f = await fixture();
  try { const pid = await f.foreign(); expect((await f.install()).code).not.toBe(0); const after = await f.ctl("print", `${domain}/${f.label}`); expect(after.code).toBe(0); expect(after.stdout).toContain(`pid = ${pid}`); expect(await Bun.file(f.config).exists()).toBe(false); }
  finally { await f.close(); }
});

test("installer rollback preserves plist created during service preflight", async () => {
  const f = await fixture();
  try { f.hook(() => writeFile(f.plist, "race winner\n")); expect((await f.install()).code).not.toBe(0); expect(await readFile(f.plist, "utf8")).toBe("race winner\n"); expect(await Bun.file(f.config).exists()).toBe(false); }
  finally { await f.close(); }
});

test("bootstrap rejection never boots out racing same-label job", async () => {
  const f = await fixture(); let pid = "";
  try { f.hook(async () => { pid = await f.foreign(); }); expect((await f.install()).code).not.toBe(0); const after = await f.ctl("print", `${domain}/${f.label}`); expect(after.code).toBe(0); expect(after.stdout).toContain(`pid = ${pid}`); expect(await Bun.file(f.config).exists()).toBe(false); expect(await Bun.file(f.plist).exists()).toBe(false); }
  finally { await f.close(); }
});

test("failed bootstrap cleans only newly created config and plist", async () => {
  const f = await fixture();
  try { expect((await f.ctl("disable", `${domain}/${f.label}`)).code).toBe(0); const result = await f.install(); expect(result.code).not.toBe(0); expect(result.stderr).toContain("bootstrap failed"); expect(await Bun.file(f.config).exists()).toBe(false); expect(await Bun.file(f.plist).exists()).toBe(false); }
  finally { await f.close(); }
});

test("current built runner launchd run-loop logs real tick then status and explicit uninstall", async () => {
  const f = await fixture();
  try {
    expect((await f.install()).code).toBe(0);
    const log = join(f.dir, "runner.log"); let tick = "";
    for (let i = 0; i < 200; i++) { tick = await readFile(log, "utf8").catch(() => ""); if (tick.includes('"shadow":false')) break; await Bun.sleep(50); }
    expect(JSON.parse(tick.trim().split("\n")[0]!)).toEqual({ protocol: 1, shadow: false, decisions: [] });
    const status = JSON.parse((await f.cli("status")).stdout); expect(status.launcher.code).toBe(0); expect(status.observation.available).toBe(true);
    expect((await f.cli("uninstall")).code).toBe(0); expect(await Bun.file(f.config).exists()).toBe(false); expect(await Bun.file(f.plist).exists()).toBe(false);
  } finally { await f.close(); }
}, 30_000);
