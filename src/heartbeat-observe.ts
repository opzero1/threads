import type { OpenCodeClient } from "@opencode/client";
import type { HeartbeatSnapshot } from "./heartbeat-rpc";
import type { HeartbeatObservation } from "./heartbeat-types";

export async function heartbeatObserve(client: OpenCodeClient, snapshot: HeartbeatSnapshot): Promise<HeartbeatObservation> {
  const startedAt = Date.now();
  try {
    if (!snapshot.run) throw new Error(snapshot.unavailable ?? "raw run unavailable");
    const { record, run } = snapshot;
    const active = await client.session.active();
    const ids = new Set([record.ownerID, ...run.sessionIDs]);
    const sessions: Extract<HeartbeatObservation, { kind: "complete" }>["sessions"] = [];
    const queue = [...ids];
    for (let index = 0; index < queue.length; index++) {
      if (queue.length > 1_000) throw new Error("native descendant traversal exceeds bound");
      const id = queue[index];
      const session = await client.session.get({ sessionID: id });
      if (id === record.ownerID && (session.parentID !== undefined || session.metadata?.opThreads !== undefined || session.projectID !== record.binding.projectID)) throw new Error("owner scope changed");
      const [inbox, permissions, forms] = await Promise.all([
        client.session.inbox.list({ sessionID: id }), client.permission.list({ sessionID: id }), client.session.form.list({ sessionID: id }),
      ]);
      sessions.push({ id, parentID: session.parentID, projectID: session.projectID, busy: active[id] !== undefined,
        queued: inbox.length > 0, permission: permissions.length > 0, form: forms.length > 0, revert: session.revert !== undefined,
        interrupted: session.outcome === "interrupted", idleAt: session.time.idle ?? Date.now() });
      let cursor: string | undefined;
      do {
        const children = await client.session.list({ parentID: id, limit: 100, cursor });
        for (const child of children.data) {
          if (!ids.has(child.id)) { ids.add(child.id); queue.push(child.id); }
        }
        cursor = children.cursor.next ?? undefined;
      } while (cursor);
    }
    let admission: Extract<HeartbeatObservation, { kind: "complete" }>["admission"] = null;
    const pending = record.pendingAdmission;
    if (pending && Date.now() >= pending.nextCheckAt) {
      const inbox = await client.session.inbox.list({ sessionID: record.ownerID });
      const item = inbox.find((entry) => entry.id === pending.messageID);
      if (item) {
        if (item.type !== "synthetic" || item.payload.metadata?.heartbeatMonitorID !== record.monitorID) throw new Error("exact inbox admission identity mismatch");
        admission = { messageID: pending.messageID, found: true, evidence: "exact synthetic inbox ID and monitor metadata" };
      } else {
        try {
          const message = await client.session.message.get({ sessionID: record.ownerID, messageID: pending.messageID });
          if (message.type !== "synthetic" || message.metadata?.heartbeatMonitorID !== record.monitorID) throw new Error("exact message admission identity mismatch");
          admission = { messageID: pending.messageID, found: true, evidence: "exact synthetic message ID and monitor metadata" };
        } catch {
          admission = { messageID: pending.messageID, found: false, evidence: "exact ID not observable; absence does not prove non-admission or authorize repost" };
        }
      }
    }
    return { kind: "complete", at: startedAt, ownerID: record.ownerID, runID: run.id, directory: run.directory, sessions, admission };
  } catch (error) { return { kind: "unavailable", at: Date.now(), reason: String(error).slice(0, 2_000) }; }
}
