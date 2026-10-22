import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { Apply, HeartbeatRpc, SnapshotInput } from "../src/heartbeat-rpc";
import { z } from "zod";
import { heartbeatCycle, heartbeatOnce, RunnerConfig } from "../src/heartbeat-runner";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { record } from "./heartbeat-policy.test";
import { heartbeatView } from "../src/heartbeat-policy";

test("actual SDK cycle records an apply conflict and still applies later monitors and pages", async () => {
  const applied: string[] = [];
  const pages: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    if (url.pathname.endsWith("/snapshot")) {
      const { input } = z.object({ input: SnapshotInput }).parse(body);
      const cursor = input.afterOwnerID ?? "first";
      pages.push(cursor);
      const ids = cursor === "first" ? ["conflict", "next"] : ["later-page"];
      return Response.json({ output: { protocol: 1, entries: ids.map((id) => ({ record: { ...record, monitorID: id }, run: null })), ...(cursor === "first" ? { next: "page2" } : {}) } });
    }
    if (url.pathname.endsWith("/apply")) {
      const { input } = z.object({ input: Apply }).parse(body);
      applied.push(input.monitorID);
      if (input.monitorID === "conflict") return Response.json({ _tag: "InvalidRequestError", message: "Heartbeat revision conflict", kind: "Body" }, { status: 400 });
      return Response.json({ output: heartbeatView({ ...record, monitorID: input.monitorID }, { kind: "hold", reason: "raw run unavailable" }) });
    }
    throw new Error(`Unexpected HTTP request ${url.pathname}`);
  } });
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() });
    const config = RunnerConfig.parse({ protocol: 1, serviceFile: "/unused", hostDirectory: "/host", node: process.execPath, runner: "/runner.mjs", intervalMs: 60_000, label: "com.opthreads.heartbeat.test", launchAgentsDirectory: "/unused" });
    const result = await heartbeatCycle(config, false, { client, rpc: client.rpc(HeartbeatRpc) });
    expect(applied).toEqual(["conflict", "next", "later-page"]);
    expect(pages).toEqual(["first", "page2"]);
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions[0]).toMatchObject({ monitorID: "conflict", status: "unavailable" });
    expect(result.decisions[1]).toMatchObject({ monitorID: "next", decision: { kind: "hold" } });
    expect(result.decisions[2]).toMatchObject({ monitorID: "later-page" });
  } finally { await server.stop(true); }
});

for (const hostname of ["127.0.0.1", "0.0.0.0", "::", "::1", "[::]", "[::1]", "localhost"]) test(`connect-only runner accepts native local bind ${hostname} with PID/version/auth checks`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-bind-"));
  const serviceFile = join(dir, "service.json");
  let snapshots = 0;
  const snapshotHosts: string[] = [];
  const server = Bun.serve({ hostname: hostname.replace(/[\[\]]/g, ""), port: 0, fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:local-fixture-only").toString("base64")}`) return new Response("Unauthorized", { status: 401 });
    if (new URL(request.url).pathname === "/api/info") return Response.json({ pid: process.pid, version: "2.1.1" });
    if (new URL(request.url).pathname.endsWith("/snapshot")) { snapshots++; snapshotHosts.push(new URL(request.url).hostname); return Response.json({ output: { protocol: 1, entries: [] } }); }
    return new Response("Unexpected request", { status: 500 });
  } });
  const registration = { url: `http://${hostname}:${server.port}`, pid: process.pid, version: "2.1.1", password: "local-fixture-only" };
  const config = RunnerConfig.parse({ protocol: 1, serviceFile, hostDirectory: dir, node: process.execPath, runner: "/unused", intervalMs: 60_000, label: "com.opthreads.heartbeat.test", launchAgentsDirectory: dir });
  try {
    await writeFile(serviceFile, JSON.stringify(registration));
    const original = await readFile(serviceFile, "utf8");
    expect(await heartbeatOnce(config, false)).toEqual({ protocol: 1, shadow: false, decisions: [] });
    expect(snapshots).toBe(1);
    expect(snapshotHosts).toEqual([hostname.includes("::") ? "[::1]" : hostname === "localhost" ? "localhost" : "127.0.0.1"]);
    expect(await readFile(serviceFile, "utf8")).toBe(original);
    for (const bad of [{ ...registration, pid: process.pid + 1 }, { ...registration, version: "incompatible" }, { ...registration, password: "wrong" }]) {
      await writeFile(serviceFile, JSON.stringify(bad));
      await expect(heartbeatOnce(config, false)).rejects.toThrow("Existing compatible service unavailable");
    }
    expect(snapshots).toBe(1);
    for (const url of ["http://192.0.2.1:12345", "http://example.com:12345", "ftp://127.0.0.1:12345"]) {
      await writeFile(serviceFile, JSON.stringify({ ...registration, url }));
      await expect(heartbeatOnce(config, false)).rejects.toThrow("loopback");
    }
  } finally { await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
