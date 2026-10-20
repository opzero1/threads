import { describe, expect, spyOn, test } from "bun:test";
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
  test("an unbounded real runner creates no deadline timer and caller cancellation drains its internal host signal", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let hostCancelled = false;
    const schedule = spyOn(globalThis, "setTimeout");
    const promise = run('return await agent("wait");', { signal: controller.signal, host: host({
      agent: async (_input, signal) => {
        started();
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => {
          hostCancelled = true;
          reject(signal.reason);
        }, { once: true }));
      },
    }) });
    try {
      await didStart;
      expect(schedule.mock.calls).toEqual([]);
      controller.abort(new Error("explicit cancellation"));
      await expect(promise).rejects.toThrow("explicit cancellation");
      expect(hostCancelled).toBe(true);
      expect(await run("return true;")).toBe(true);
    } finally { controller.abort(); schedule.mockRestore(); }
  });

  test("computed data keys remain usable while CodeMode rejects computed Function construction", async () => {
    expect(await run('const key = "va" + "lue"; return args[key];')).toBe(7);
    await expect(run(`const key = "constructo" + "r";
      const F = (() => {})[key]; return F("return typeof process")();`)).rejects.toThrow("Function constructor is not supported");
    expect(await run('const key = "__prot" + "o__"; const value = {}; value[key] = {leaked: 1}; return value.leaked === undefined;')).toBe(true);
    expect(await run('const key = "getPrototype" + "Of"; return Object[key](Object[key]({})) === null;')).toBe(true);
    await expect(run(`const key = "getPrototype" + "Of"; const ctor = "constructo" + "r";
      const F = Object[key]({})[ctor][ctor]; return F("return typeof process")();`)).rejects.toThrow("Function constructor is not supported");
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

  test("parallel settles every slot before rethrowing and rejects non-function elements", async () => {
    const finished: string[] = [];
    const agentHost = host({ agent: async (input) => {
      const prompt = (input as { prompt: string }).prompt;
      if (prompt.startsWith("bad")) throw new Error(prompt + " exploded");
      await Bun.sleep(10);
      finished.push(prompt);
      return prompt;
    } });
    expect((await failure(run(`return await parallel([() => agent("bad-0"), () => agent("slow")]);`, { host: agentHost }))).message)
      .toContain("bad-0 exploded");
    expect(finished).toEqual(["slow"]);
    expect(await run(`try { await parallel([() => agent("bad-0"), () => agent("ok"), () => agent("bad-2")]); }
      catch (error) { return { name: error.name, message: error.message, errors: error.errors.map((item) => item.message) }; }`, { host: agentHost }))
      .toEqual({ name: "AggregateError", message: "parallel items 0, 2 failed: bad-0 exploded; bad-2 exploded", errors: ["bad-0 exploded", "bad-2 exploded"] });
    expect(finished).toEqual(["slow", "ok"]);
    expect((await failure(run(`return await parallel([agent("eager")]);`))).message).toContain("parallel expects an array of functions, not promises");
  });

  test("pipeline passes the original item and index to every stage and settles every item", async () => {
    expect(await run(`return await pipeline(["a", "b"],
      async (value, item, index) => value + index,
      async (value, item, index) => [value, item, index]
    );`)).toEqual([["a0", "a", 0], ["b1", "b", 1]]);
    const finished: number[] = [];
    expect(await run(`try { await pipeline([0, 1, 2], async (value) => agent(String(value)), async (value, item) => item); }
      catch (error) { return { name: error.name, message: error.message }; }`, { host: host({ agent: async (input) => {
      const prompt = Number((input as { prompt: string }).prompt);
      if (prompt === 1) throw new Error("item 1 exploded");
      await Bun.sleep(10);
      finished.push(prompt);
      return prompt;
    } }) })).toEqual({ name: "Error", message: "item 1 exploded" });
    expect(finished).toEqual([0, 2]);
  });

  test("preserves host failures", async () => {
    expect((await failure(run(`return await agent("bad");`, {
      host: host({ agent: async (input) => { if ((input as { prompt: string }).prompt === "bad") throw new Error("host exploded"); return "ok"; } }),
    }))).message).toContain("host exploded");
  });

  test("preempts synchronous native RegExp work without blocking the parent event loop", async () => {
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats++; }, 5);
    const started = performance.now();
    try {
      const input = "a".repeat(30) + "!";
      const error = await failure(run(`return /^(a+)+$/.test(${JSON.stringify(input)});`, { timeoutMs: 20 }));
      expect(error.message).toContain("timed out");
      expect(performance.now() - started).toBeLessThan(500);
      expect(heartbeats).toBeGreaterThan(0);
    } finally {
      clearInterval(heartbeat);
    }
  });

  test("aborts and drains cooperative Promise.race losers before rejecting", async () => {
    let slowStarted = false;
    let slowCancelled = false;
    const error = await failure(run(`return await Promise.race([agent("fast"), agent("slow")]);`, {
      host: host({ agent: async (input, signal) => {
        const prompt = (input as { prompt: string }).prompt;
        if (prompt === "fast") return "fast";
        slowStarted = true;
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => {
          slowCancelled = true;
          reject(signal.reason);
        }, { once: true }));
      } }),
    }));
    expect(error.message).toContain("unawaited host operations");
    expect(slowStarted).toBe(true);
    expect(slowCancelled).toBe(true);
  });

  test("does not deadlock ordinary failure on a non-cooperative Promise.race loser", async () => {
    let slowStarted = false;
    const started = performance.now();
    const error = await failure(run(`return await Promise.race([agent("fast"), agent("slow")]);`, {
      host: host({ agent: async (input) => {
        if ((input as { prompt: string }).prompt === "fast") return "fast";
        slowStarted = true;
        await new Promise<void>(() => {});
      } }),
    }));
    expect(error.message).toContain("unawaited host operations");
    expect(slowStarted).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("supports bounded nested workflow host execution", async () => {
    const child = `${meta}\nreturn { child: args.value + 1 };`;
    const value = await run(`return await workflow("child", args);`, {
      host: host({ workflow: async (input, signal) => executeWorkflow({
        script: child,
        args: input.args,
        signal: signal ?? new AbortController().signal,
        host: host(),
        timeoutMs: 1_000,
      }) }),
    });
    expect(value).toEqual({ child: 8 });
  });

  test("bounds host failure diagnostics", async () => {
    const error = await failure(run(`return await agent("large failure");`, {
      host: host({ agent: async () => { throw new Error("💥".repeat(1024 * 1024)); } }),
    }));
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(8_300);
    expect(error.message).toContain("truncated");
  });

  test("the runtime reference's retry and discovery loops run as written", async () => {
    const reference = await Bun.file(new URL("../skills/workflow-authoring/references/runtime.md", import.meta.url)).text();
    const example = (heading: string) => reference.split(`### ${heading}\n\n\`\`\`js\n`)[1]!.split("```")[0]!;
    const keys: string[] = [];
    const reply = (replies: Record<string, unknown>) => host({ agent: async (input) => {
      const key = (input as { key: string }).key;
      keys.push(key);
      return replies[key];
    } });
    expect(await run(`${example("Retry until accepted")}return draft;`, { host: reply({
      "draft:1": "first", "check:1": { ok: false, feedback: "cite evidence" },
      "draft:2": "second", "check:2": { ok: true },
    }) })).toBe("second");
    expect(keys).toEqual(["draft:1", "check:1", "draft:2", "check:2"]);
    keys.length = 0;
    expect(await run(`${example("Loop until dry")}return findings;`, { host: reply({
      "find:1": [{ id: "a" }, { id: "b" }], "find:2": [{ id: "b" }, { id: "c" }], "find:3": [{ id: "a" }],
    }) })).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(keys).toEqual(["find:1", "find:2", "find:3"]);
  });

  test("removed helpers fail validation with their plain-JavaScript replacement", async () => {
    for (const [name, pattern] of [["retry", "Retry until accepted"], ["gate", "Retry until accepted"], ["loopUntilDry", "Loop until dry"]]) {
      let called = false;
      const error = await failure(run(`await agent("first"); return await ${name}(() => 1);`, { host: host({ agent: async () => { called = true; } }) }));
      expect(error.message).toContain(`${name}() was removed`);
      expect(error.message).toContain(pattern);
      expect(called).toBe(false);
    }
    expect(await run(`const retry = async (thunk) => thunk(); return retry(() => 3);`)).toBe(3);
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

  test("validates wrapper inputs and timeout options", async () => {
    expect((await failure(run(`return await agent(4);`))).message).toContain("prompt");
    expect((await failure(run(`return await checkpoint("x", {});`))).message).toContain("key");
    expect((await failure(run(`return true;`, { timeoutMs: 0 }))).message).toContain("positive integer");
    expect((await failure(run(`while (true) {}`, { timeoutMs: 10 }))).message).toMatch(/Timeout|timed out/);
    expect((await failure(run(`return await agent("large");`, {
      host: host({ agent: async () => "x".repeat(2 * 1024 * 1024) }),
    }))).message).toContain("truncated");
  });

  test("failed worker construction does not consume runtime capacity", async () => {
    const original = globalThis.Worker;
    const errors: string[] = [];
    Reflect.set(globalThis, "Worker", class {
      constructor() { throw new Error("Worker construction unavailable"); }
    });
    try {
      for (let index = 0; index < 65; index++) errors.push((await failure(run("return true;"))).message);
    } finally {
      Reflect.set(globalThis, "Worker", original);
    }
    expect(errors.every((message) => message === "Worker construction unavailable")).toBe(true);
    expect(await run("return true;")).toBe(true);
  });
});
