import { afterEach, expect, jest, test } from "bun:test";
import { ClientError } from "@opencode/client/promise";
import { refreshHarness, settle } from "./support/refresh-harness";

const dropped = () => new ClientError("Transport", { cause: new Error("The socket connection was closed unexpectedly.") });
const toasts = (errors: unknown[]) => errors.map((error) => (error as { message: string }).message);
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    jest.advanceTimersByTime(500);
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
  }
}

afterEach(() => jest.useRealTimers());

test("a dropped connection retries worker snapshots without a toast and recovers", async () => {
  const h = await refreshHarness();
  try {
    jest.useFakeTimers();
    h.failWorkerSnapshots(dropped());
    const before = h.counts.workerSnapshots;
    h.event("session.status");
    await advance(500);
    expect(h.counts.workerSnapshots).toBeGreaterThan(before);
    const failed = h.counts.workerSnapshots;
    await advance(2000);
    expect(h.counts.workerSnapshots).toBeGreaterThan(failed);
    h.failWorkerSnapshots();
    await advance(4000);
    expect(toasts(h.errors)).toEqual([]);
    const recovered = h.counts.workerSnapshots;
    await advance(30_000);
    expect(h.counts.workerSnapshots).toBe(recovered);
  } finally {
    h.dispose();
  }
});

test("a persistent transport failure is reported once after the grace period", async () => {
  const h = await refreshHarness();
  try {
    jest.useFakeTimers();
    h.failWorkerSnapshots(dropped());
    h.event("session.status");
    await advance(14_000);
    expect(toasts(h.errors)).toEqual([]);
    await advance(6000);
    const reported = ["Threads: Transport: The socket connection was closed unexpectedly."];
    expect(toasts(h.errors)).toEqual(reported);
    await advance(10_000);
    expect(toasts(h.errors)).toEqual(reported);
  } finally {
    h.dispose();
  }
});

test("disposal during a refresh leaves no retry timer behind", async () => {
  const h = await refreshHarness();
  jest.useFakeTimers();
  jest.clearAllTimers();
  h.holdWorkerSnapshots(dropped);
  const before = h.counts.workerSnapshots;
  h.event("session.status");
  await advance(1500);
  expect(h.counts.workerSnapshots - before).toBe(1);
  h.dispose();
  for (let hop = 0; hop < 20; hop++) await Promise.resolve();
  expect(jest.getTimerCount()).toBe(0);
  expect(toasts(h.errors)).toEqual([]);
});

test("other worker snapshot failures are still reported immediately", async () => {
  const h = await refreshHarness();
  try {
    h.failWorkerSnapshots(new ClientError("UnexpectedStatus", { detail: "500" }));
    h.event("session.status");
    await settle();
    expect(toasts(h.errors)).toContain("Threads: UnexpectedStatus: 500");
  } finally {
    h.dispose();
  }
});
