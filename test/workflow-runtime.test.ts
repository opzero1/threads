import { describe, expect, test } from "bun:test";
import { executeWorkflow, parseWorkflow, type WorkflowHost } from "../src/workflow-runtime";

const meta = `export const meta = { name: "test", description: "runtime test", phases: [{ title: "Run" }] };`;

function host(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    agent: async (input) => input,
    phase: async () => {},
    log: async () => {},
    checkpoint: async (input) => input,
    workflow: async (input) => input,
    ...overrides,
  };
}

const run = (body: string, options: Partial<Parameters<typeof executeWorkflow>[0]> = {}) =>
  executeWorkflow({ script: `${meta}\n${body}`, args: { value: 7 }, signal: new AbortController().signal, host: host(), ...options });

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}

describe("workflow metadata", () => {
  test("parses a required first literal declaration without evaluating it", () => {
    expect(parseWorkflow(`${meta}\nreturn args;`)).toEqual({
      meta: { name: "test", description: "runtime test", phases: [{ title: "Run" }] },
      body: "return args;",
    });
    expect(() => parseWorkflow(`const x = 1; ${meta}`)).toThrow("first statement");
    expect(() => parseWorkflow(`export const meta = { name: f(), description: "x" };`)).toThrow("literal");
  });
});

describe("real CodeMode workflow execution", () => {
  test("computed data keys remain usable while CodeMode rejects computed Function construction", async () => {
    expect(await run('const key = "va" + "lue"; return args[key];')).toBe(7);
    await expect(run(`const key = "constructo" + "r";
      const F = (() => {})[key]; return F("return typeof process")();`)).rejects.toThrow("Function constructor is not supported");
    expect(await run('const key = "__prot" + "o__"; const value = {}; value[key] = {leaked: 1}; return value.leaked === undefined;')).toBe(true);
    await expect(run('const key = "getPrototype" + "Of"; return Object[key]({});')).rejects.toThrow("not a function");
    await expect(run('const key = "define" + "Property"; const value = {}; Object[key](value, "x", {value:1}); return value;')).rejects.toThrow("not a function");
  });
  test("returning before a started agent finishes cannot claim workflow success", async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await expect(run('agent("work", {key:"one"}); return true;', {
        host: host({ agent: async () => { await pending; return "late result"; } }),
      })).rejects.toThrow();
    } finally {
      finish();
    }
  });
  test("passes args without source serialization and exposes shaped wrappers", async () => {
    const calls: unknown[] = [];
    const value = await run(`
      await phase("Run");
      await log("hello");
      const a = await agent("inspect", { key: "a" });
      const c = await checkpoint("continue?", { key: "approval", extra: 1 });
      const w = await workflow("child", args);
      const empty = await workflow("empty");
      return { a, c, w, empty, args };
    `, { args: { text: "`; throw new Error('injected') //" }, host: host({
      agent: async (input) => { calls.push(input); return input; },
      checkpoint: async (input) => { calls.push(input); return input; },
    }) });
    expect(calls).toEqual([{ key: "a", prompt: "inspect" }, { key: "approval", extra: 1, prompt: "continue?" }]);
    expect(value).toMatchObject({ w: { name: "child" }, empty: { name: "empty" }, args: { text: expect.any(String) } });
  });

  test("parallel starts work concurrently and preserves input order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const promise = run(`return await parallel([() => agent("first"), () => agent("second")]);`, {
      host: host({ agent: async (input) => { const prompt = (input as { prompt: string }).prompt; started.push(prompt); await blocked; return prompt; } }),
    });
    while (started.length < 2) await Bun.sleep(1);
    expect(started).toEqual(["first", "second"]);
    release();
    expect(await promise).toEqual(["first", "second"]);
  });

  test("pipeline runs all stages per item without a global barrier", async () => {
    const events: string[] = [];
    const result = await run(`return await pipeline([1, 2],
      async (item) => agent("s1-" + item),
      async (item) => agent("s2-" + item)
    );`, { host: host({ agent: async (input) => {
      const prompt = (input as { prompt: string }).prompt;
      events.push(prompt);
      if (prompt === "s1-1") await Bun.sleep(10);
      return prompt.endsWith("1") || prompt.endsWith("2") ? Number(prompt.slice(-1)) : prompt;
    } }) });
    expect(result).toEqual([1, 2]);
    expect(events.indexOf("s2-2")).toBeLessThan(events.indexOf("s2-1"));
  });

  test("preserves failures and enforces bounded helpers", async () => {
    let calls = 0;
    expect((await failure(run(`return await agent("bad");`, {
      host: host({ agent: async (input) => { if ((input as { prompt: string }).prompt === "bad") throw new Error("host exploded"); return "ok"; } }),
    }))).message).toContain("host exploded");
    expect(await run(`return await retry(async (attempt) => { await agent("try"); if (attempt < 3) throw new Error("again"); return "done"; });`,
      { host: host({ agent: async () => { calls++; return null; } }) })).toBe("done");
    expect(calls).toBe(3);
    expect((await failure(run(`return retry(() => 1, { attempts: 0 });`))).message).toContain("positive integer");
  });

  test("gate and loopUntilDry retry deterministically and retain ordered unique results", async () => {
    const value = await run(`
      let gateAttempt = 0;
      const accepted = await gate(async () => ++gateAttempt, (result) => result === 2);
      const found = await loopUntilDry({
        key: "id",
        consecutiveEmpty: 2,
        maxRounds: 6,
        round: async (round) => round === 1 ? [{ id: "a" }, { id: "b" }] : round === 2 ? [{ id: "b" }, { id: "c" }] : [],
      });
      return { accepted, found };
    `);
    expect(value).toEqual({ accepted: 2, found: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(await run(`return gate(() => "yes", () => ({ ok: true }));`)).toBe("yes");
    expect((await failure(run(`return gate(() => "no", () => ({ ok: false, feedback: "bad evidence" }), { attempts: 1 });`))).message)
      .toContain("bad evidence");
    expect((await failure(run(`return gate(() => "no", () => ({ truthy: true }), { attempts: 1 });`))).message)
      .toContain("boolean or { ok");
  });

  test("cancels an in-flight real tool through Effect.runPromise signal", async () => {
    const controller = new AbortController();
    let hostCancelled = false;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const promise = executeWorkflow({ script: `${meta}\nreturn await agent("wait");`, args: null, signal: controller.signal,
      host: host({ agent: async () => {
        started();
        try {
          await new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("host cancelled")), { once: true }));
        } finally {
          hostCancelled = true;
        }
      } }) });
    await didStart;
    controller.abort();
    expect(await failure(promise)).toBeInstanceOf(Error);
    expect(hostCancelled).toBe(true);
  });

  test("rejects invalid scripts before any host call", async () => {
    for (const body of [
      `return Date.now();`,
      `const D = Date; return D.now();`,
      `return Math.random();`,
      `const M = Math; return M["random"]();`,
      `let M; M = Math; return M.random();`,
      `const { random } = Math; return random();`,
      `return (m => m.random())(Math);`,
      `const container = { m: Math }; return container.m.random();`,
      `const container = [Math]; return container[0].random();`,
      `const selected = true ? Math : Object; return selected.random();`,
      `const { random: r } = Math; return r();`,
      `const container = { Math }; return container.Math.random();`,
      `return mystery();`,
      `return { mystery };`,
      `return tools.runtime.agent({ prompt: "bypass" });`,
      `return import("x");`,
    ]) {
      let called = false;
      expect(await failure(run(body, { host: host({ agent: async () => { called = true; } }) }))).toBeInstanceOf(Error);
      expect(called).toBe(false);
    }
  });

  test("allows deterministic direct Math and Symbol constants but blocks prototype escapes before tools", async () => {
    expect(await run(`return { floor: Math.floor(1.9), symbolStable: Symbol.iterator === Symbol.iterator };`))
      .toEqual({ floor: 1, symbolStable: true });
    for (const body of [
      `return ({}).constructor.constructor("return process")();`,
      `return ({})["__proto__"];`,
      `return Object.getPrototypeOf({});`,
    ]) {
      let called = false;
      const error = await failure(run(`await agent("must not run"); ${body}`, {
        host: host({ agent: async () => { called = true; } }),
      }));
      expect(error).toBeInstanceOf(Error);
      expect(called).toBe(false);
    }
  });

  test("validates wrapper inputs and call/timeout options", async () => {
    expect((await failure(run(`return await agent(4);`))).message).toContain("prompt");
    expect((await failure(run(`return await checkpoint("x", {});`))).message).toContain("key");
    expect((await failure(run(`await log("a"); await log("b"); return true;`, { maxCalls: 1 }))).message).toContain("call limit");
    expect((await failure(run(`return true;`, { maxCalls: 0 }))).message).toContain("positive integer");
    expect((await failure(run(`while (true) {}`, { timeoutMs: 10 }))).message).toMatch(/Timeout|timed out/);
    expect((await failure(run(`return await agent("large");`, {
      host: host({ agent: async () => "x".repeat(2 * 1024 * 1024) }),
    }))).message).toContain("truncated");
  });
});
