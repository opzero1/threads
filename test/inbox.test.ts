import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxUnavailable, serviceInbox } from "../src/inbox";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

async function service(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { method: string; path: string; auth: string | null; body: string }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push({ method: request.method, path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body: await request.text() });
    return handler(request);
  } });
  cleanup.push(async () => server.stop(true));
  const dir = await mkdtemp(join(tmpdir(), "threads-inbox-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "service.json");
  const register = (pid: number, password = "secret") =>
    writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, pid, password }));
  return { requests, file, register };
}

test("service inbox calls its own registered service with basic auth", async () => {
  const s = await service(request => {
    if (request.method === "GET") return Response.json({ data: [{ id: "msg_a" }, { id: "msg_b" }] });
    if (request.method === "PATCH") return new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  });
  await s.register(4242);
  const inbox = serviceInbox({ file: () => s.file, pid: 4242 });
  expect(await inbox.pending("ses_1")).toEqual(["msg_a", "msg_b"]);
  expect(await inbox.steer("ses_1", "msg_a")).toBe("moved");
  expect(await inbox.queue("ses_1", "msg_a")).toBe("moved");
  await inbox.cancel("ses_1", "msg_b");
  expect(s.requests.map(r => `${r.method} ${r.path} ${r.body}`)).toEqual([
    "GET /api/session/ses_1/inbox ",
    `PATCH /api/session/ses_1/inbox/msg_a {"delivery":"steer"}`,
    `PATCH /api/session/ses_1/inbox/msg_a {"delivery":"queue"}`,
    "DELETE /api/session/ses_1/inbox/msg_b ",
  ]);
  expect(new Set(s.requests.map(r => r.auth))).toEqual(new Set([`Basic ${Buffer.from("opencode:secret").toString("base64")}`]));
});

test("service inbox reports a conflicting delivery change as unavailable", async () => {
  const s = await service(() => new Response("not pending", { status: 409 }));
  await s.register(4242);
  const inbox = serviceInbox({ file: () => s.file, pid: 4242 });
  expect(await inbox.steer("ses_1", "msg_a")).toBe("unavailable");
});

test("service inbox ignores another process's registration", async () => {
  const s = await service(() => Response.json({ data: [] }));
  await s.register(4242);
  const inbox = serviceInbox({ file: () => s.file, pid: 1 });
  await expect(inbox.pending("ses_1")).rejects.toThrow(inboxUnavailable);
  expect(s.requests).toEqual([]);
});

test("service inbox rediscovers once after the service rotates its password", async () => {
  let password = "old";
  const s = await service(request => request.headers.get("authorization") === `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    ? Response.json({ data: [] }) : new Response(null, { status: 401 }));
  await s.register(4242, "old");
  const inbox = serviceInbox({ file: () => s.file, pid: 4242 });
  expect(await inbox.pending("ses_1")).toEqual([]);
  password = "new";
  await s.register(4242, "new");
  expect(await inbox.pending("ses_1")).toEqual([]);
  expect(s.requests).toHaveLength(3);
});
