import { Service } from "@opencode/client/service";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const unavailable = "Existing compatible service unavailable; connect-only runner will not start it";
const Version = z.enum(["2.1.0", "2.1.1", "2.1.2"]);
const Registration = z.object({
  url: z.string().transform((value, context) => {
    const native = /^(https?:\/\/)(::1|::):([0-9]+)\/?$/.exec(value);
    const normalized = native ? `${native[1]}[${native[2]}]:${native[3]}` : value;
    if (!/^https?:\/\/(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|\[::\])(?::[0-9]+)?\/?$/.test(normalized)) {
      context.addIssue({ code: "custom", message: "Heartbeat requires an unambiguous loopback service" });
      return z.NEVER;
    }
    try {
      const url = new URL(normalized);
      if (url.port === "0") throw new Error("Invalid port");
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
      if (url.hostname === "[::]") url.hostname = "[::1]";
      return url.toString();
    } catch {
      context.addIssue({ code: "custom", message: "Heartbeat requires a valid loopback service" });
      return z.NEVER;
    }
  }),
  pid: z.number().int().positive(),
  version: Version,
  password: z.string().optional(),
});
const Info = z.object({ pid: z.number().int().positive(), version: Version });

export const heartbeatFetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) }),
  { preconnect: fetch.preconnect },
);

export async function heartbeatEndpoint(file: string) {
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error("Existing service registration unavailable; connect-only runner will not start it");
  });
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new Error(unavailable); }
  const registration = Registration.safeParse(input);
  if (!registration.success) {
    if (registration.error.issues.some((issue) => issue.path[0] === "url")) throw new Error("Heartbeat requires a valid unambiguous loopback service");
    throw new Error(unavailable);
  }
  const { url, pid, password, version } = registration.data;
  const endpoint = { url, auth: password === undefined ? undefined : { type: "basic" as const, username: "opencode", password } };
  try {
    const response = await heartbeatFetch(new URL("/api/info", url), { headers: Service.headers(endpoint), signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(unavailable);
    const info = Info.parse(await response.json());
    if (info.pid !== pid || info.version !== version) throw new Error(unavailable);
    return endpoint;
  } catch {
    throw new Error(unavailable);
  }
}
