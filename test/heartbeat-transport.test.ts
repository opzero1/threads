import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { heartbeatOnce, RunnerConfig } from "../src/heartbeat-runner";

test("transport supports OpenCode 2.1 while rejecting 2.0, unknown, and mismatched registered and live versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-upgrade-"));
  const file = join(dir, "service.json");
  const config = RunnerConfig.parse({ protocol: 1, serviceFile: file, hostDirectory: dir, node: process.execPath, runner: "/unused", intervalMs: 60_000, label: "com.opthreads.heartbeat.test", launchAgentsDirectory: dir });
  let version = "2.1.2";
  let snapshots = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:upgrade-fixture").toString("base64")}`);
    if (new URL(request.url).pathname === "/api/info") return Response.json({ pid: process.pid, version });
    snapshots++;
    return Response.json({ output: { protocol: 1, entries: [] } });
  } });
  const put = (registered: string) => writeFile(file, JSON.stringify({ url: server.url.toString(), pid: process.pid, version: registered, password: "upgrade-fixture" }));
  try {
    await put("2.1.2");
    const original = await readFile(file, "utf8");
    expect(await heartbeatOnce(config, false)).toEqual({ protocol: 1, shadow: false, decisions: [] });
    expect(snapshots).toBe(1);
    version = "2.1.1";
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    expect(await readFile(file, "utf8")).toBe(original);
    version = "2.1.2";
    await put("2.1.1");
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    await put("2.1.3");
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    version = "2.0.28";
    await put("2.0.28");
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    expect(snapshots).toBe(1);
  } finally { await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("transport rejects unsafe registrations, bad health and redirects without issuing monitor writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-transport-"));
  const file = join(dir, "service.json");
  const config = RunnerConfig.parse({ protocol: 1, serviceFile: file, hostDirectory: dir, node: process.execPath, runner: "/unused", intervalMs: 60_000, label: "com.opthreads.heartbeat.test", launchAgentsDirectory: dir });
  let leaked = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked++; return Response.json({}); } });
  let requests = 0;
  let snapshots = 0;
  let mode = "ready";
  const server = Bun.serve({ hostname: "::1", port: 0, fetch(request) {
    requests++;
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`);
    const path = new URL(request.url).pathname;
    if (mode === "redirect" || (mode === "rpc-redirect" && path !== "/api/info")) return Response.redirect(trap.url.toString(), 302);
    if (path === "/api/info") {
      if (mode === "slow") return new Promise<Response>(() => {});
      return Response.json({ pid: mode === "pid" ? process.pid + 1 : process.pid, version: mode === "version" ? "2.0.28" : "2.1.1" }, { status: mode === "status" ? 500 : 200 });
    }
    snapshots++;
    expect(path.endsWith("/snapshot")).toBe(true);
    return Response.json({ output: { protocol: 1, entries: [] } });
  } });
  const registration = { url: `http://::1:${server.port}`, pid: process.pid, version: "2.1.1", password: "fixture-password" };
  const put = async (value: unknown) => writeFile(file, JSON.stringify(value));
  try {
    for (const url of ["http://192.0.2.1:12345", "http://example.com", `http://fixture-password@127.0.0.1:${server.port}`, "http://::2:12345", "http://::1", "http://::1:12345/path", "http://::1:0", "http://::1:65536", "http://127.1:12345", "http://2130706433:12345", "http://localhost.:12345", "http://localhost:12345?x=1", "http://localhost:12345#x", "http://localhost:12345\\@example.com", "ftp://localhost:12345"]) {
      await put({ ...registration, url });
      await expect(heartbeatOnce(config, false)).rejects.toThrow("loopback");
    }
    for (const bad of [{ ...registration, pid: 0 }, { ...registration, pid: "1" }, { ...registration, password: 123 }, { ...registration, version: "2.0.28" }]) {
      await put(bad);
      await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    }
    await writeFile(file, '{"password":"fixture-password');
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    expect(requests).toBe(0);
    await put(registration);
    const original = await readFile(file, "utf8");
    for (mode of ["pid", "version", "status", "redirect", "slow"]) {
      const started = Date.now();
      await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
      if (mode === "slow") expect(Date.now() - started).toBeLessThan(3_000);
      expect(await readFile(file, "utf8")).toBe(original);
    }
    expect(snapshots).toBe(0);
    mode = "rpc-redirect";
    await expect(heartbeatOnce(config, false)).rejects.toThrow();
    expect(leaked).toBe(0);
    mode = "ready";
    expect(await heartbeatOnce(config, false)).toEqual({ protocol: 1, shadow: false, decisions: [] });
    expect(snapshots).toBe(1);
    expect(await readFile(file, "utf8")).toBe(original);
  } finally { await server.stop(true); await trap.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("each cycle rereads native registration after outage and new local listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-restart-"));
  const file = join(dir, "service.json");
  const config = RunnerConfig.parse({ protocol: 1, serviceFile: file, hostDirectory: dir, node: process.execPath, runner: "/unused", intervalMs: 60_000, label: "com.opthreads.heartbeat.test", launchAgentsDirectory: dir });
  let snapshots = 0;
  const start = () => Bun.serve({ hostname: "::1", port: 0, fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:restart-fixture").toString("base64")}`) return new Response(null, { status: 401 });
    if (new URL(request.url).pathname === "/api/info") return Response.json({ pid: process.pid, version: "2.1.1" });
    snapshots++;
    return Response.json({ output: { protocol: 1, entries: [] } });
  } });
  let server = start();
  const put = async () => {
    const bytes = JSON.stringify({ url: `http://::1:${server.port}`, pid: process.pid, version: "2.1.1", password: "restart-fixture" });
    await writeFile(file, bytes);
    return bytes;
  };
  try {
    const original = await put();
    await heartbeatOnce(config, false);
    await server.stop(true);
    await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    expect(snapshots).toBe(1);
    expect(await readFile(file, "utf8")).toBe(original);
    server = start();
    const refreshed = await put();
    await heartbeatOnce(config, false);
    expect(snapshots).toBe(2);
    expect(await readFile(file, "utf8")).toBe(refreshed);
    await rm(file);
    await expect(heartbeatOnce(config, false)).rejects.toThrow("registration unavailable");
    expect(snapshots).toBe(2);
  } finally { await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
