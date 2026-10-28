import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// OpenCode 2.2 serves session inbox steering and cancellation over HTTP only; the plugin session
// API does not expose them. A plugin runs inside the server process, so it may call its own
// service when that process registered itself as the local OpenCode service.
export interface Inbox {
  /** Lists pending inbox IDs. Throws when the inbox API is unreachable. */
  pending(sessionID: string): Promise<string[]>;
  /** `moved` when the item changed delivery mode; `unavailable` when it is no longer pending in the other mode. */
  steer(sessionID: string, inboxID: string): Promise<"moved" | "unavailable">;
  queue(sessionID: string, inboxID: string): Promise<"moved" | "unavailable">;
  /** Removes a pending item. Items already delivered or missing are a no-op. */
  cancel(sessionID: string, inboxID: string): Promise<void>;
}

export const inboxUnavailable =
  "The OpenCode inbox API is unavailable: it needs OpenCode 2.2 running as the local service (`opencode serve --service`) in this process";

const Registration = z.object({
  url: z.string().refine(value => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/.test(value)),
  pid: z.number().int().positive(),
  password: z.string().optional(),
});

export const registrationFile = () =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json");

export function serviceInbox(options: { file?: () => string; pid?: number; fetch?: typeof fetch } = {}): Inbox {
  const send = options.fetch ?? fetch;
  let cached: Promise<{ url: string; headers: Record<string, string> }> | undefined;

  async function discover() {
    const text = await readFile((options.file ?? registrationFile)(), "utf8").catch(() => undefined);
    let parsed: unknown;
    try { parsed = text === undefined ? undefined : JSON.parse(text); } catch { parsed = undefined; }
    const registration = Registration.safeParse(parsed);
    // Only this process's own registration: never another service or a stale file.
    if (!registration.success || registration.data.pid !== (options.pid ?? process.pid)) throw new Error(inboxUnavailable);
    const { url, password } = registration.data;
    const auth: Record<string, string> = password === undefined ? {}
      : { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    return { url, headers: { ...auth, "content-type": "application/json" } };
  }

  async function request(path: string, init: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      cached ??= discover();
      const endpoint = await cached.catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
      let response: Response;
      try {
        response = await send(new URL(path, endpoint.url), {
          ...init, headers: endpoint.headers, redirect: "error", signal: AbortSignal.timeout(10_000),
        });
      } catch {
        cached = undefined;
        if (attempt === 0) continue;
        throw new Error(inboxUnavailable);
      }
      // A restarted service has a new password or port; rediscover once.
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      return response;
    }
  }

  const path = (sessionID: string, inboxID?: string) =>
    `/api/session/${encodeURIComponent(sessionID)}/inbox${inboxID === undefined ? "" : `/${encodeURIComponent(inboxID)}`}`;

  async function failure(response: Response, action: string) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    return new Error(`Inbox ${action} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  async function deliver(sessionID: string, inboxID: string, delivery: "steer" | "queue") {
    const response = await request(path(sessionID, inboxID), { method: "PATCH", body: JSON.stringify({ delivery }) });
    if (response.status === 409) return "unavailable" as const;
    if (!response.ok) throw await failure(response, delivery);
    return "moved" as const;
  }

  return {
    async pending(sessionID) {
      const response = await request(path(sessionID), { method: "GET" });
      if (response.status === 404) throw new Error(inboxUnavailable);
      if (!response.ok) throw await failure(response, "list");
      const body = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json());
      return body.data.map(item => item.id);
    },
    steer: (sessionID, inboxID) => deliver(sessionID, inboxID, "steer"),
    queue: (sessionID, inboxID) => deliver(sessionID, inboxID, "queue"),
    async cancel(sessionID, inboxID) {
      const response = await request(path(sessionID, inboxID), { method: "DELETE" });
      if (!response.ok) throw await failure(response, "cancel");
    },
  };
}
