import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { z } from "zod";
import {
  asksExternal,
  assertGrantsReachable,
  EXTERNAL_DIRECTORY,
  GRANTS_METADATA,
  grantAccess,
  grantNotice,
  recordedGrants,
  withResolvedGrants,
  workerRestrictions,
} from "./external-access";
import { permissionMatches, requireDelegation } from "./permissions";
import { Report, WorkerView } from "./rpc";
import { GrantedPaths } from "./workflow-types";

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
    agent: z.string().min(1).optional().describe(
      "Configured agent ID in the worker's directory. Omit to inherit the caller's agent and model.",
    ),
    paths: GrantedPaths.optional().describe(
      "Existing absolute directories outside the worker's directory that it may use without asking, within its permissions. Explicit external_directory denies still win. Unlisted directories follow the worker's own permissions.",
    ),
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
export const WorkflowWorker = z.object({
  ownerID: sessionID,
  runID: z.string().min(1),
  stepKey: z.string().min(1),
  callerAgent: z.string().min(1),
}).strict();

const digest = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const workerIdentity = (coordinatorID: string, key: string) =>
  Session.ID.make(`ses_${digest([coordinatorID, key]).slice(0, 32)}`);
// Callers pass resolved grants. The object element cannot collide with a string agent ID.
export const fingerprint = (input: z.infer<typeof Spawn>) =>
  digest([
    input.title,
    input.directory,
    input.task,
    ...(input.agent === undefined ? [] : [input.agent]),
    ...(input.paths === undefined || input.paths.length === 0 ? [] : [{ paths: input.paths }]),
  ]);

const locks = new Map<string, Promise<void>>();
type WorkflowExecutionGrant = { watching: boolean };
const workflowState = globalThis as typeof globalThis & { __opWorkflowExecutionGrantsV2?: Map<string, WorkflowExecutionGrant> };
const workflowExecutionGrants = workflowState.__opWorkflowExecutionGrantsV2 ??= new Map<string, WorkflowExecutionGrant>();
export function authorizeWorkflowExecution(workerID: string) {
  workflowExecutionGrants.set(workerID, { watching: false });
}
export function workflowExecutionAuthorized(workerID: string) {
  return workflowExecutionGrants.has(workerID);
}
export function watchWorkflowExecution(workerID: string, untilIdle: () => Promise<void>) {
  const grant = workflowExecutionGrants.get(workerID);
  if (!grant || grant.watching) return;
  grant.watching = true;
  const revoke = () => {
    if (workflowExecutionGrants.get(workerID) === grant) workflowExecutionGrants.delete(workerID);
  };
  void untilIdle().then(revoke, revoke);
}
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

// `role` is the worker's configured profile. Read steps project it onto read-only actions; write
// steps rely on it through the agent rules that precede these session rules.
export function workflowPermissions(
  inherited: Permission.Ruleset,
  worker: { access: "read" | "write"; role: Permission.Ruleset; paths?: readonly string[] },
): Permission.Ruleset {
  const readActions = ["read", "glob", "grep", "webfetch", "websearch", "skill", EXTERNAL_DIRECTORY];
  return [
    ...(worker.access === "read" ? [
      { action: "*", resource: "*", effect: "deny" as const },
      ...inherited.filter((rule) => rule.effect === "ask").map((rule) => ({ ...rule, effect: "deny" as const })),
      ...worker.role.flatMap((rule) => readActions
        .filter((action) => permissionMatches(rule.action, action))
        .map((action) => ({ ...rule, action }))),
      ...inherited.filter((rule) => rule.effect === "deny"),
    ] : workerRestrictions(inherited, worker.role)),
    ...grantAccess(inherited, worker.role, worker.paths),
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "threads_*", resource: "*", effect: "deny" },
    { action: "workflows_*", resource: "*", effect: "deny" },
    { action: "workflows_result", resource: "*", effect: "allow" },
  ];
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
  const initializedKey = (link: z.infer<typeof Link>) =>
    `initialized/${link.workerID}/${link.initialMessageID}`;

  async function initialized(session: NativeSession, link: z.infer<typeof Link>) {
    return session.metadata?.opThreadsRole !== true ||
      await ctx.storage.get(initializedKey(link)) === true;
  }

  async function callerPermissions(session: NativeSession, agentID: string) {
    const agent = await ctx.agent.get({ agentID, location: session.location });
    return [...agent.data.permissions, ...(session.permissions ?? [])];
  }

  // A location loads its agents on first use, so a new worker directory can briefly report a
  // configured agent as missing. Retry like the workflow engine's profile lookup.
  async function rolePermissions(agentID: string, directory: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await ctx.agent.get({ agentID, location: { directory } })).data.permissions;
      } catch (error) {
        if (attempt >= 49 || !String(error).includes(`Agent not found: ${agentID}`)) throw error;
        await Bun.sleep(100);
      }
    }
  }

  // Read workers start with an empty placeholder profile; prepareWorkflowPrompt applies the real
  // profile from the worker's location. Grants are checked against that profile before creation.
  async function workflowWorkerPermissions(
    inherited: Permission.Ruleset,
    agentID: string,
    directory: string,
    access: "read" | "write",
    paths: readonly string[] | undefined,
  ) {
    const needsRole = paths !== undefined || (access === "write" && asksExternal(inherited));
    const role = needsRole ? await rolePermissions(agentID, directory) : [];
    assertGrantsReachable([...role, ...workflowPermissions(inherited, { access, role, paths })], paths);
    return workflowPermissions(inherited, { access, role: access === "read" ? [] : role, paths });
  }

  async function prepareRole(
    session: NativeSession,
    link: z.infer<typeof Link>,
    messageID: string,
    callerAgent: string,
  ) {
    if (await initialized(session, link)) return;
    if (link.initialMessageID !== messageID || session.agent === undefined) {
      throw new Error(
        "Worker initialization is pending. Retry the original dispatch request.",
      );
    }
    const coordinator = await ctx.session.get({ sessionID: link.coordinatorID });
    requireDelegation(
      await callerPermissions(coordinator, callerAgent),
      session.agent,
    );
    const agent = await ctx.agent.get({
      agentID: session.agent,
      location: session.location,
    });
    if (agent.data.model) {
      await ctx.session.switchModel({
        sessionID: session.id,
        model: agent.data.model,
      });
    }
  }

  async function journalReport(
    session: NativeSession,
    link: z.infer<typeof Link>,
    input: z.infer<typeof Report>,
    silent: boolean,
  ) {
    let canonical = Report.parse(input);
    if (!silent) {
      const admitted = await ctx.session.synthetic({
        sessionID: link.coordinatorID,
        id: link.reportMessageID,
        text: `Managed worker ${link.workerID} (${link.key}) report:\n${JSON.stringify(input)}`,
        metadata: { opThreadsReport: input, workerID: link.workerID },
        delivery: "queue",
        resume: true,
      });
      canonical = Report.parse(admitted.payload.metadata?.opThreadsReport);
      if (JSON.stringify(canonical) !== JSON.stringify(Report.parse(input))) {
        throw new Error("This worker already has a different report. Start a new task with a new spawn key.");
      }
    }
    const existing = await ctx.storage.get(reportKey(link));
    if (existing !== undefined && JSON.stringify(Report.parse(existing)) !== JSON.stringify(canonical)) {
      throw new Error("This worker already has a different report. Start a new task with a new spawn key.");
    }
    await ctx.storage.set(reportKey(link), canonical);
    return canonical;
  }

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
      agent: session.agent ?? null,
      model: session.model ?? null,
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
          await ctx.storage.remove(initializedKey(link));
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
    async preparePrompt(actor: string, messageID: string, callerAgent: unknown) {
      const session = await ctx.session.get({ sessionID: actor });
      if (session.metadata?.opThreadsRole !== true) return;
      const recorded = Link.parse(session.metadata.opThreads);
      if (session.parentID !== undefined || recorded.workerID !== session.id) return;
      const link = workerLink(session);
      if (await initialized(session, link)) return;
      await prepareRole(session, link, messageID, z.string().min(1).parse(callerAgent));
    },
    async prepareWorkflowPrompt(actor: string, messageID: string) {
      const session = await ctx.session.get({ sessionID: actor });
      const workflow = WorkflowWorker.safeParse(session.metadata?.opWorkflow);
      if (!workflow.success) return;
      const link = workerLink(session);
      if (await initialized(session, link)) {
        authorizeWorkflowExecution(actor);
        return;
      }
      await prepareRole(session, link, messageID, workflow.data.callerAgent);
      if (!await initialized(session, link) && session.metadata?.opWorkflowAccess === "read") {
        const coordinator = await ctx.session.get({ sessionID: link.coordinatorID });
        const profile = await ctx.agent.get({ agentID: session.agent!, location: session.location });
        const paths = recordedGrants(session.metadata);
        const permissions = workflowPermissions(await callerPermissions(coordinator, workflow.data.callerAgent), {
          access: "read", role: profile.data.permissions, paths,
        });
        assertGrantsReachable([...profile.data.permissions, ...permissions], paths);
        await ctx.session.update({ sessionID: session.id, permissions });
      }
    },
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
        const request = await withResolvedGrants(input);
        const workerID = workerIdentity(actor, input.key);
        let session = await ctx.session.get({ sessionID: workerID }).catch(
          (error: unknown) => {
            const missing = MissingSession.safeParse(error);
            if (!missing.success || missing.data.sessionID !== workerID)
              throw error;
            return undefined;
          },
        );
        const existing = await list(actor);
        if (
          !session &&
          existing.filter(
            (worker) =>
              !worker.report &&
              worker.outcome !== "failed" &&
              worker.outcome !== "interrupted",
          ).length >= limit
        ) {
          throw new Error(`Coordinator worker limit reached (${limit})`);
        }
        const proposed = Link.parse({
          workerID,
          coordinatorID: actor,
          key: input.key,
          fingerprint: fingerprint(request),
          initialMessageID: SessionMessage.ID.create(),
          reportMessageID: SessionMessage.ID.create(),
        });
        if (!session) {
          const inherited = await callerPermissions(coordinator, runtime.agent);
          if (input.agent !== undefined) requireDelegation(inherited, input.agent);
          // A role-selected worker inherits only the coordinator session's restrictions. Its role
          // is loaded when a preserved ask or a grant must be checked against the role's denies.
          const restricted = coordinator.permissions ?? [];
          const role = input.agent !== undefined && (request.paths !== undefined || asksExternal(restricted))
            ? await rolePermissions(input.agent, input.directory)
            : [];
          const permissions: Permission.Rule[] = [
            ...(input.agent === undefined ? inherited : workerRestrictions(restricted, role)),
            ...grantAccess(inherited, role, request.paths),
            { action: "threads_report", resource: "*", effect: "allow" },
          ];
          assertGrantsReachable([...role, ...permissions], request.paths);
          session = await ctx.session.create({
            id: workerID,
            title: input.title,
            location: { directory: input.directory },
            agent: input.agent ?? runtime.agent,
            model: runtime.model,
            permissions,
            metadata: {
              opThreads: proposed,
              ...(input.agent === undefined ? {} : { opThreadsRole: true }),
              ...(request.paths === undefined ? {} : { [GRANTS_METADATA]: request.paths }),
            },
          });
        }
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
          metadata: input.agent === undefined
            ? undefined
            : { opThreadsCallerAgent: runtime.agent },
          text: `${input.task}\n\nYou are a managed worker assigned to ${input.directory}. Work only within the assigned scope.${grantNotice(request.paths)} You may use native subagent for bounded tasks or reviews when useful, within the brief's delegation limits and your permissions. Delegation is optional. Pass relevant context, scope, and constraints to each subagent. Do not call threads_spawn. Review your subagents' results and resolve any outstanding work before reporting. Only you call threads_report with the combined verdict, summary, and evidence; subagents return results to you. Runtime completion alone does not establish task success.`,
        });
        if (input.agent !== undefined) {
          await ctx.storage.set(initializedKey(link), true);
        }
        return view(await ctx.session.get({ sessionID: workerID }));
      });
    },
    async reserveWorkflow(
      actor: string,
      input: z.infer<typeof Spawn>,
      sourceDirectory: string,
      runtime: Pick<ToolContext, "agent"> & Pick<SessionContext, "model">,
      workflow: { ownerID: Session.ID; runID: string; stepKey: string; callerAgent: string; access: "read" | "write" },
    ) {
      return serialized(actor, async () => {
        const coordinator = await ctx.session.get({ sessionID: actor });
        if (workflow.ownerID !== actor || workflow.callerAgent !== runtime.agent) {
          throw new Error("Workflow worker ownership must be server-derived");
        }
        if (coordinator.parentID !== undefined || coordinator.metadata?.opThreads !== undefined) {
          throw new Error("Native subagents and managed workers cannot start workflow workers");
        }
        if (!isAbsolute(sourceDirectory) || !(await stat(sourceDirectory)).isDirectory()) {
          throw new Error("Workflow source must be an existing absolute directory");
        }
        if (input.agent === undefined) throw new Error("Workflow workers require an explicit role agent");
        const request = await withResolvedGrants(input);
        const workerID = workerIdentity(actor, input.key);
        const proposed = Link.parse({
          workerID, coordinatorID: actor, key: input.key, fingerprint: fingerprint(request),
          initialMessageID: SessionMessage.ID.create(), reportMessageID: SessionMessage.ID.create(),
        });
        let session = await ctx.session.get({ sessionID: workerID }).catch((error: unknown) => {
          const missing = MissingSession.safeParse(error);
          if (!missing.success || missing.data.sessionID !== workerID) throw error;
          return undefined;
        });
        if (!session) {
          const existing = await list(actor);
          if (existing.filter((worker) => !worker.report && worker.outcome !== "failed" && worker.outcome !== "interrupted").length >= limit) {
            throw new Error(`Coordinator worker limit reached (${limit}); wait for existing managed work before starting another workflow`);
          }
          const inherited = await callerPermissions(coordinator, runtime.agent);
          requireDelegation(inherited, input.agent);
          session = await ctx.session.create({
            id: workerID, title: input.title, location: { directory: sourceDirectory },
            model: runtime.model,
            permissions: await workflowWorkerPermissions(inherited, input.agent, sourceDirectory, workflow.access, request.paths),
            metadata: {
              opThreads: proposed, opThreadsRole: true,
              opWorkflow: { ownerID: workflow.ownerID, runID: workflow.runID, stepKey: workflow.stepKey, callerAgent: workflow.callerAgent },
              opWorkflowAccess: workflow.access,
              ...(request.paths === undefined ? {} : { [GRANTS_METADATA]: request.paths }),
            },
          });
        }
        const link = workerLink(session);
        const recorded = WorkflowWorker.parse(session.metadata?.opWorkflow);
        if (link.fingerprint !== proposed.fingerprint || recorded.ownerID !== workflow.ownerID ||
          recorded.runID !== workflow.runID || recorded.stepKey !== workflow.stepKey ||
          recorded.callerAgent !== workflow.callerAgent || session.metadata?.opWorkflowAccess !== workflow.access) {
          throw new Error("This workflow reservation belongs to a different request");
        }
        if (await initialized(session, link) && session.location.directory !== input.directory) {
          throw new Error("Initialized workflow worker cannot change its assigned directory");
        }
        await ctx.storage.set(indexKey(link), link);
        return session.projectID;
      });
    },
    async spawnWorkflow(
      actor: string,
      input: z.infer<typeof Spawn>,
      runtime: Pick<ToolContext, "agent"> & Pick<SessionContext, "model">,
      workflow: z.infer<typeof WorkflowWorker> & { access: "read" | "write" },
    ) {
      return serialized(actor, async () => {
        const workflowMetadata = WorkflowWorker.parse({
          ownerID: workflow.ownerID,
          runID: workflow.runID,
          stepKey: workflow.stepKey,
          callerAgent: workflow.callerAgent,
        });
        const coordinator = await ctx.session.get({ sessionID: actor });
        if (workflow.ownerID !== actor || workflow.callerAgent !== runtime.agent) {
          throw new Error("Workflow worker ownership must be server-derived");
        }
        if (coordinator.parentID !== undefined || coordinator.metadata?.opThreads !== undefined) {
          throw new Error("Native subagents and managed workers cannot start workflow workers");
        }
        if (!isAbsolute(input.directory) || !(await stat(input.directory)).isDirectory()) {
          throw new Error("directory must be an existing absolute directory");
        }
        if (input.agent === undefined) throw new Error("Workflow workers require an explicit role agent");
        const request = await withResolvedGrants(input);
        const workerID = workerIdentity(actor, input.key);
        let session = await ctx.session.get({ sessionID: workerID }).catch((error: unknown) => {
          const missing = MissingSession.safeParse(error);
          if (!missing.success || missing.data.sessionID !== workerID) throw error;
          return undefined;
        });
        const proposed = Link.parse({
          workerID,
          coordinatorID: actor,
          key: input.key,
          fingerprint: fingerprint(request),
          initialMessageID: SessionMessage.ID.create(),
          reportMessageID: SessionMessage.ID.create(),
        });
        if (!session) {
          const existing = await list(actor);
          if (existing.filter((worker) => !worker.report && worker.outcome !== "failed" && worker.outcome !== "interrupted").length >= limit) {
            throw new Error(`Coordinator worker limit reached (${limit}); wait for existing managed work before starting another workflow`);
          }
          const inherited = await callerPermissions(coordinator, runtime.agent);
          requireDelegation(inherited, input.agent);
          session = await ctx.session.create({
            id: workerID,
            title: input.title,
            location: { directory: input.directory },
            agent: input.agent,
            model: runtime.model,
            permissions: await workflowWorkerPermissions(inherited, input.agent, input.directory, workflow.access, request.paths),
            metadata: {
              opThreads: proposed, opThreadsRole: true, opWorkflow: workflowMetadata, opWorkflowAccess: workflow.access,
              ...(request.paths === undefined ? {} : { [GRANTS_METADATA]: request.paths }),
            },
          });
        }
        const link = workerLink(session);
        const recorded = WorkflowWorker.parse(session.metadata?.opWorkflow);
        if (link.fingerprint !== proposed.fingerprint || JSON.stringify(recorded) !== JSON.stringify(workflowMetadata)) {
          throw new Error("This workflow spawn identity belongs to a different request");
        }
        if (session.location.directory !== input.directory) {
          if (await initialized(session, link)) throw new Error("Initialized workflow worker cannot change its assigned directory");
          await ctx.session.move({ sessionID: link.workerID, directory: input.directory });
          session = await ctx.session.get({ sessionID: link.workerID });
        }
        if (session.agent !== input.agent) {
          if (await initialized(session, link)) throw new Error("Initialized workflow worker cannot change its role agent");
          await ctx.session.switchAgent({ sessionID: link.workerID, agent: input.agent });
          session = await ctx.session.get({ sessionID: link.workerID });
        }
        await ctx.storage.set(indexKey(link), link);
        if (!await initialized(session, link)) {
          await ctx.session.prompt({
            sessionID: link.workerID,
            id: link.initialMessageID,
            delivery: "queue",
            metadata: { opThreadsCallerAgent: runtime.agent, opWorkflowRunID: workflow.runID },
            text: `${input.task}\n\nYou are a leaf workflow worker. Do not delegate, spawn or control other workers, or operate workflow controls. Work only in ${input.directory}.${grantNotice(request.paths)} Finish by submitting one accepted workflows_result with a verdict, concise summary, evidence, and a result matching the requested JSON schema. If validation rejects your result, correct it and resubmit. Native completion without that validated report is not success.`,
          });
          await ctx.storage.set(initializedKey(link), true);
        }
        return view(await ctx.session.get({ sessionID: workerID }));
      });
    },
    async send(actor: string, input: z.infer<typeof Send>) {
      const { session, link } = await owned(actor, input.workerID);
      if (!await initialized(session, link)) {
        throw new Error("Worker initialization is pending. Retry the original threads_spawn request.");
      }
      const id = SessionMessage.ID.make(
        `msg_${digest([input.workerID, "send", input.key]).slice(0, 32)}`,
      );
      if (session.metadata?.opWorkflow !== undefined) authorizeWorkflowExecution(input.workerID);
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
        resume: false,
      });
      return view(await ctx.session.get({ sessionID: input.workerID }));
    },
    async report(actor: string, input: z.infer<typeof Report>) {
      const session = await ctx.session.get({ sessionID: actor });
      const link = workerLink(session);
      if (session.metadata?.opWorkflow !== undefined) throw new Error("Workflow workers must call workflows_result");
      const canonical = await journalReport(session, link, input, false);
      return { workerID: link.workerID, report: canonical };
    },
    async reportWorkflow(actor: string, input: z.infer<typeof Report>) {
      const session = await ctx.session.get({ sessionID: actor });
      WorkflowWorker.parse(session.metadata?.opWorkflow);
      const link = workerLink(session);
      const report = { verdict: input.verdict, summary: input.summary, evidence: input.evidence };
      return { workerID: link.workerID, report: await journalReport(session, link, report, true) };
    },
  };
}
