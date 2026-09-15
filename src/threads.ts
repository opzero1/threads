import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { z } from "zod";
import { Report, WorkerView } from "./rpc";

const sessionID = z.string().transform((value) => Session.ID.make(value));
const messageID = z
  .string()
  .transform((value) => SessionMessage.ID.make(value));
const MissingSession = z.object({
  _tag: z.literal("Session.NotFoundError"),
  sessionID,
});
export const Link = z
  .object({
    workerID: sessionID,
    coordinatorID: sessionID,
    key: z.string().min(1),
    fingerprint: z.string().min(1),
    initialMessageID: messageID,
    reportMessageID: messageID,
  })
  .strict();
export const Spawn = z
  .object({
    key: z.string().min(1).max(200),
    title: z.string().min(1),
    directory: z.string().min(1),
    task: z.string().min(1),
  })
  .strict();
export const Send = z
  .object({
    workerID: sessionID,
    key: z.string().min(1).max(200),
    text: z.string().min(1),
  })
  .strict();
export const WorkerTarget = z.object({ workerID: sessionID }).strict();

const digest = (parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const workerIdentity = (coordinatorID: string, key: string) =>
  Session.ID.make(`ses_${digest([coordinatorID, key]).slice(0, 32)}`);
export const fingerprint = (input: z.infer<typeof Spawn>) =>
  digest([input.title, input.directory, input.task]);

const locks = new Map<string, Promise<void>>();
export async function serialized<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

type NativeSession = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
export function workerLink(
  session: Pick<NativeSession, "id" | "parentID" | "metadata">,
) {
  const link = Link.parse(session.metadata?.opThreads);
  if (
    session.parentID !== undefined ||
    link.workerID !== session.id ||
    workerIdentity(link.coordinatorID, link.key) !== session.id
  ) {
    throw new Error("Not the original managed worker");
  }
  return link;
}

export function threads(
  ctx: Pick<Plugin.Context, "session" | "agent" | "storage">,
  limit = 4,
) {
  const indexKey = (link: z.infer<typeof Link>) =>
    `workers/${link.coordinatorID}/${link.workerID}`;
  const reportKey = (link: z.infer<typeof Link>) =>
    `reports/${link.workerID}/${link.reportMessageID}`;
  const visibilityKey = (link: z.infer<typeof Link>) =>
    `visibility/${link.workerID}/${link.reportMessageID}`;

  async function view(
    session: NativeSession,
  ): Promise<z.infer<typeof WorkerView>> {
    const link = workerLink(session);
    const stored = await ctx.storage.get(reportKey(link));
    const report = stored === undefined ? null : Report.parse(stored);
    const visibility = await ctx.storage.get(visibilityKey(link));
    return {
      workerID: link.workerID,
      coordinatorID: link.coordinatorID,
      key: link.key,
      title: session.title ?? link.key,
      directory: session.location.directory,
      outcome: session.outcome ?? null,
      report,
      hidden:
        visibility === undefined
          ? report?.verdict === "PASS" || report?.verdict === "PASS WITH NOTES"
          : z.boolean().parse(visibility),
    };
  }

  async function list(coordinatorID: string) {
    const workers: z.infer<typeof WorkerView>[] = [];
    let after: string | undefined;
    do {
      const page = await ctx.storage.scan({
        prefix: `workers/${Session.ID.make(coordinatorID)}/`,
        after,
        limit: 100,
      });
      for (const entry of page.entries) {
        const link = Link.parse(entry.value);
        if (link.coordinatorID !== coordinatorID)
          throw new Error("Worker index ownership mismatch");
        let session: NativeSession;
        try {
          session = await ctx.session.get({ sessionID: link.workerID });
        } catch (error) {
          const missing = MissingSession.safeParse(error);
          if (!missing.success || missing.data.sessionID !== link.workerID)
            throw error;
          await ctx.storage.remove(reportKey(link));
          await ctx.storage.remove(visibilityKey(link));
          await ctx.storage.remove(entry.key);
          continue;
        }
        workers.push(await view(session));
      }
      after = page.next;
    } while (after);
    return workers;
  }

  async function owned(actor: string, workerID: string) {
    const session = await ctx.session.get({ sessionID: workerID });
    const link = workerLink(session);
    if (link.coordinatorID !== actor)
      throw new Error("Only the owning coordinator may control this worker");
    return { session, link };
  }

  return {
    list,
    async hide(actor: string, input: z.infer<typeof WorkerTarget>) {
      const { session, link } = await owned(actor, input.workerID);
      await ctx.storage.set(visibilityKey(link), true);
      return view(session);
    },
    async restore(coordinatorID: string) {
      const workers = await list(coordinatorID);
      return Promise.all(
        workers.map(async (worker) => {
          if (!worker.hidden) return worker;
          const { session, link } = await owned(coordinatorID, worker.workerID);
          await ctx.storage.set(visibilityKey(link), false);
          return view(session);
        }),
      );
    },
    async spawn(
      actor: string,
      input: z.infer<typeof Spawn>,
      runtime: Pick<ToolContext, "agent"> & Pick<SessionContext, "model">,
    ) {
      return serialized(actor, async () => {
        const coordinator = await ctx.session.get({ sessionID: actor });
        if (
          coordinator.parentID !== undefined ||
          coordinator.metadata?.opThreads !== undefined
        ) {
          throw new Error(
            "Native subagents and managed workers cannot spawn managed workers",
          );
        }
        if (
          !isAbsolute(input.directory) ||
          !(await stat(input.directory)).isDirectory()
        ) {
          throw new Error("directory must be an existing absolute directory");
        }
        const workerID = workerIdentity(actor, input.key);
        const existing = await list(actor);
        if (
          !existing.some((worker) => worker.workerID === workerID) &&
          existing.filter(
            (worker) =>
              !worker.report &&
              worker.outcome !== "failed" &&
              worker.outcome !== "interrupted",
          ).length >= limit
        ) {
          throw new Error(`Coordinator worker limit reached (${limit})`);
        }
        const agent = await ctx.agent.get({
          agentID: runtime.agent,
          location: coordinator.location,
        });
        const proposed = Link.parse({
          workerID,
          coordinatorID: actor,
          key: input.key,
          fingerprint: fingerprint(input),
          initialMessageID: SessionMessage.ID.create(),
          reportMessageID: SessionMessage.ID.create(),
        });
        const session = await ctx.session.create({
          id: workerID,
          title: input.title,
          location: { directory: input.directory },
          agent: runtime.agent,
          model: runtime.model,
          permissions: [
            ...agent.data.permissions,
            ...(coordinator.permissions ?? []),
          ],
          metadata: { opThreads: proposed },
        });
        const link = workerLink(session);
        if (
          link.coordinatorID !== actor ||
          link.fingerprint !== proposed.fingerprint
        ) {
          throw new Error(
            "This spawn key already belongs to a different request",
          );
        }
        await ctx.storage.set(indexKey(link), link);
        await ctx.session.prompt({
          sessionID: link.workerID,
          id: link.initialMessageID,
          delivery: "queue",
          text: `${input.task}\n\nYou are a managed worker assigned to ${input.directory}. Work only within the assigned scope. You may use native subagent for bounded tasks or reviews when useful, within the brief's delegation limits and inherited permissions. Delegation is optional. Pass relevant context, scope, and constraints to each subagent. Do not call threads_spawn. Review your subagents' results and resolve any outstanding work before reporting. Only you call threads_report with the combined verdict, summary, and evidence; subagents return results to you. Runtime completion alone does not establish task success.`,
        });
        return view(await ctx.session.get({ sessionID: workerID }));
      });
    },
    async send(actor: string, input: z.infer<typeof Send>) {
      const { link } = await owned(actor, input.workerID);
      const id = SessionMessage.ID.make(
        `msg_${digest([input.workerID, "send", input.key]).slice(0, 32)}`,
      );
      const admitted = await ctx.session.synthetic({
        sessionID: input.workerID,
        id,
        text: input.text,
        delivery: "queue",
        resume: true,
      });
      if (admitted.payload.text !== input.text)
        throw new Error("This send key already belongs to different text");
      if ((await ctx.storage.get(reportKey(link))) !== undefined) {
        await ctx.storage.set(visibilityKey(link), false);
      } else {
        await ctx.storage.remove(visibilityKey(link));
      }
      return { workerID: input.workerID, messageID: admitted.id };
    },
    async interrupt(actor: string, input: z.infer<typeof WorkerTarget>) {
      await owned(actor, input.workerID);
      await ctx.session.interrupt({
        sessionID: input.workerID,
        continue: false,
      });
      return view(await ctx.session.get({ sessionID: input.workerID }));
    },
    async report(actor: string, input: z.infer<typeof Report>) {
      const session = await ctx.session.get({ sessionID: actor });
      const link = workerLink(session);
      const admitted = await ctx.session.synthetic({
        sessionID: link.coordinatorID,
        id: link.reportMessageID,
        text: `Managed worker ${link.workerID} (${link.key}) report:\n${JSON.stringify(input)}`,
        metadata: { opThreadsReport: input, workerID: link.workerID },
        delivery: "queue",
        resume: true,
      });
      const canonical = Report.parse(
        admitted.payload.metadata?.opThreadsReport,
      );
      await ctx.storage.set(reportKey(link), canonical);
      if (JSON.stringify(canonical) !== JSON.stringify(input)) {
        throw new Error("This worker already has a different report. Start a new task with a new spawn key.");
      }
      return { workerID: link.workerID, report: canonical };
    },
  };
}
