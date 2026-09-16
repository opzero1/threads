import { describe, expect, test } from "bun:test";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  Link,
  Spawn,
  fingerprint,
  serialized,
  workerIdentity,
  workerLink,
} from "../src/threads";
import { Report, ThreadsRpc } from "../src/rpc";

const coordinatorID = Session.ID.create();
const workerID = workerIdentity(coordinatorID, "review");
const link = Link.parse({
  workerID,
  coordinatorID,
  key: "review",
  fingerprint: "task-fingerprint",
  initialMessageID: SessionMessage.ID.create(),
  reportMessageID: SessionMessage.ID.create(),
});

describe("native identity and caller boundaries", () => {
  test("same coordinator and key converge to a schema-valid native session ID", () => {
    expect(workerIdentity(coordinatorID, "review")).toBe(workerID);
    expect(Session.ID.make(workerID)).toBe(workerID);
    expect(workerIdentity(Session.ID.create(), "review")).not.toBe(workerID);
    expect(workerIdentity(coordinatorID, "other")).not.toBe(workerID);
    expect(workerIdentity("ses_a:b", "c")).not.toBe(
      workerIdentity("ses_a", "b:c"),
    );
  });
  test("only the original top-level worker can adopt a link", () => {
    expect(workerLink({ id: workerID, metadata: { opThreads: link } })).toEqual(
      link,
    );
    expect(() =>
      workerLink({
        id: workerID,
        parentID: coordinatorID,
        metadata: { opThreads: link },
      }),
    ).toThrow();
    expect(() =>
      workerLink({ id: Session.ID.create(), metadata: { opThreads: link } }),
    ).toThrow();
    expect(() => workerLink({ id: workerID, metadata: {} })).toThrow();
    expect(() =>
      workerLink({
        id: workerID,
        metadata: { opThreads: { ...link, key: "other" } },
      }),
    ).toThrow();
  });
  test("metadata IDs use native validation, and extra metadata fields are rejected", () => {
    expect(() => Link.parse({ ...link, initialMessageID: "wrong" })).toThrow();
    expect(() => Link.parse({ ...link, coordinatorID: "wrong" })).toThrow();
    expect(() => Link.parse({ ...link, parentID: coordinatorID })).toThrow();
  });
  test("all spawn content participates in conflict detection", () => {
    const request = Spawn.parse({
      key: "review",
      title: "Review",
      directory: "/work",
      task: "Check",
    });
    for (const changed of [
      { ...request, title: "Other" },
      { ...request, directory: "/other" },
      { ...request, task: "Other" },
    ])
      expect(fingerprint(changed)).not.toBe(fingerprint(request));
    expect(fingerprint({ ...request })).toBe(fingerprint(request));
  });
  test("named agent selection is admitted and participates in spawn identity", () => {
    const request = { key: "roles", title: "Workstream", directory: "/work", task: "Verify" };
    const core = Spawn.parse({ ...request, agent: "vera-core" });
    const engineer = Spawn.parse({ ...request, agent: "vera-engineer" });
    expect(core.agent).toBe("vera-core");
    expect(fingerprint(core)).not.toBe(fingerprint(engineer));
    expect(fingerprint(core)).not.toBe(fingerprint(Spawn.parse(request)));
    expect(() => Spawn.parse({ ...request, agent: "" })).toThrow();
  });
  test("omitting an agent preserves the fingerprint of pre-role workers", () => {
    expect(fingerprint(Spawn.parse({ key: "roles", title: "Workstream", directory: "/work", task: "Verify" }))).toBe(
      "386dfd06102da10f8ca294a78d241e8a33d6921ff86f0615d282a618b140bdcf",
    );
  });
});

describe("admission serialization", () => {
  test("same coordinator waits, unrelated coordinator proceeds, and errors release the queue", async () => {
    const events: string[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = serialized("a", async () => {
      events.push("a1");
      await blocked;
      throw new Error("failed");
    });
    const failure = first.catch((error: unknown) => error);
    const second = serialized("a", async () => {
      events.push("a2");
    });
    await serialized("b", async () => {
      events.push("b");
    });
    expect(events).toEqual(["a1", "b"]);
    release();
    expect(await failure).toBeInstanceOf(Error);
    await second;
    expect(events).toEqual(["a1", "b", "a2"]);
    await serialized("a", async () => {
      events.push("a3");
    });
    expect(events.at(-1)).toBe("a3");
  });
});

test("RPC exposes snapshot and explicit tab restoration, with report verdicts required", () => {
  expect(Object.keys(ThreadsRpc.methods)).toEqual(["snapshot", "restore"]);
  expect(ThreadsRpc.events).toEqual({});
  expect(ThreadsRpc.methods.snapshot.errors).toEqual({});
  expect(() =>
    Report.parse({ verdict: "idle", summary: "Done", evidence: [] }),
  ).toThrow();
  expect(() => Report.parse({ verdict: "PASS", summary: "Done" })).toThrow();
});
