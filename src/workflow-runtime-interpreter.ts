import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { parse } from "acorn";
import { Effect } from "effect";

export type WorkflowHost = {
  agent(input: unknown): Promise<unknown>;
  phase(title: string): Promise<void>;
  log(message: string): Promise<void>;
  checkpoint(input: unknown): Promise<unknown>;
  workflow(input: { name: string; args?: unknown }): Promise<unknown>;
};

export type WorkflowMeta = {
  name: string;
  description: string;
  phases?: { title: string }[];
};

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const injected = new Set([
  "args",
  "agent",
  "phase",
  "log",
  "checkpoint",
  "workflow",
  "parallel",
  "pipeline",
  "retry",
  "gate",
  "loopUntilDry",
]);

const safeGlobals = new Set([
  "undefined", "NaN", "Infinity", "Object", "Array", "Math", "JSON", "Promise",
  "Symbol", "Number", "String", "Boolean", "parseInt", "parseFloat", "isFinite",
  "isNaN", "RegExp", "Map", "Set", "URL", "URLSearchParams", "Headers", "Uint8Array",
  "TextEncoder", "TextDecoder", "encodeURI", "encodeURIComponent", "decodeURI",
  "decodeURIComponent", "atob", "btoa", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "AggregateError",
]);

const deterministicMathProperties = new Set([
  "PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2",
  "max", "min", "hypot", "abs", "acos", "acosh", "asin", "asinh", "atan",
  "atan2", "atanh", "floor", "ceil", "round", "trunc", "sign", "sqrt", "cbrt",
  "pow", "cos", "cosh", "sin", "sinh", "tan", "tanh", "log", "log2", "log10",
  "log1p", "exp", "expm1", "f16round", "fround", "clz32", "imul", "sumPrecise",
]);

const prototypeEscapeProperties = new Set([
  "constructor", "prototype", "__proto__", "getPrototypeOf", "setPrototypeOf",
]);

const forbiddenGlobals = new Set([
  "Date", "performance", "crypto", "process", "fetch", "require", "globalThis",
  "window", "self", "eval", "Function", "WebAssembly", "tools", "search", "console",
]);

function ast(source: string, sourceType: "script" | "module"): Node {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  }) as unknown as Node;
}

function children(node: Node): Node[] {
  const result: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (value && typeof value === "object" && "type" in value)
      result.push(value as Node);
    else if (Array.isArray(value))
      for (const item of value)
        if (item && typeof item === "object" && "type" in item) result.push(item as Node);
  }
  return result;
}

function literal(node: Node): unknown {
  if (node.type === "Literal") return node.value;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const value = literal(node.argument as Node);
    if (typeof value === "number") return node.operator === "-" ? -value : value;
  }
  if (node.type === "ArrayExpression")
    return (node.elements as (Node | null)[]).map((item) => {
      if (!item) throw new Error("Workflow metadata cannot contain array holes");
      return literal(item);
    });
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const property of node.properties as Node[]) {
      if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method || property.shorthand)
        throw new Error("Workflow metadata must be a literal object");
      const keyNode = property.key as Node;
      const key = keyNode.type === "Identifier" ? keyNode.name : literal(keyNode);
      if (typeof key !== "string") throw new Error("Workflow metadata keys must be strings");
      if (Object.hasOwn(value, key)) throw new Error(`Duplicate workflow metadata key: ${key}`);
      value[key] = literal(property.value as Node);
    }
    return value;
  }
  throw new Error("Workflow metadata must contain only literal values");
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim() ||
      typeof value.description !== "string" || !value.description.trim())
    throw new Error("Workflow metadata requires non-empty name and description strings");
  const keys = Object.keys(value);
  if (keys.some((key) => !["name", "description", "phases"].includes(key)))
    throw new Error("Workflow metadata contains an unknown field");
  if (value.phases !== undefined && (!Array.isArray(value.phases) || value.phases.some((phase) =>
    !isRecord(phase) || Object.keys(phase).length !== 1 || typeof phase.title !== "string" || !phase.title.trim())))
    throw new Error("Workflow metadata phases must contain only non-empty titles");
  return {
    name: value.name,
    description: value.description,
    ...(value.phases === undefined ? {} : { phases: value.phases as { title: string }[] }),
  };
}

export function parseWorkflow(script: string): { meta: WorkflowMeta; body: string } {
  const program = ast(script, "module");
  const statements = program.body as Node[];
  const first = statements[0];
  if (!first || first.type !== "ExportNamedDeclaration")
    throw new Error("The first statement must be `export const meta =` with a literal object");
  const declaration = first.declaration as Node | null;
  const declarations = declaration?.declarations as Node[] | undefined;
  const item = declarations?.[0];
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declarations?.length !== 1 ||
      item?.id && ((item.id as Node).type !== "Identifier" || (item.id as Node).name !== "meta") ||
      (item?.init as Node | undefined)?.type !== "ObjectExpression")
    throw new Error("The first statement must be `export const meta =` with a literal object");
  const meta = validateMeta(literal((item as Node).init as Node));
  return { meta, body: script.slice(first.end).trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patternNames(node: Node | null | undefined, names: Set<string>): void {
  if (!node) return;
  if (node.type === "Identifier") names.add(node.name as string);
  else if (node.type === "RestElement") patternNames(node.argument as Node, names);
  else if (node.type === "AssignmentPattern") patternNames(node.left as Node, names);
  else if (node.type === "ArrayPattern") for (const item of node.elements as (Node | null)[]) patternNames(item, names);
  else if (node.type === "ObjectPattern") for (const property of node.properties as Node[])
    patternNames((property.type === "RestElement" ? property.argument : property.value) as Node, names);
}

function isReference(node: Node, parent?: Node): boolean {
  if (!parent) return true;
  if ((parent.type === "VariableDeclarator" && parent.id === node) ||
      ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") &&
       (parent.id === node || (parent.params as Node[]).includes(node))) ||
      ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key === node && !parent.computed &&
       !(parent.type === "Property" && parent.shorthand && parent.value === node)) ||
      (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
      (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") ||
      (parent.type === "CatchClause" && parent.param === node)) return false;
  return true;
}

function validateBody(body: string): void {
  const program = ast(body, "script");
  const declared = new Set<string>();
  const nodes: { node: Node; parent?: Node }[] = [];
  const visit = (node: Node, parent?: Node) => {
    nodes.push({ node, parent });
    if (node.type === "VariableDeclarator") patternNames(node.id as Node, declared);
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id)
      patternNames(node.id as Node, declared);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
      for (const param of node.params as Node[]) patternNames(param, declared);
    if (node.type === "CatchClause") patternNames(node.param as Node | null, declared);
    for (const child of children(node)) visit(child, node);
  };
  visit(program);
  for (const name of declared)
    if (injected.has(name) || name === "tools" || name === "search") throw new Error(`Workflow cannot shadow injected binding ${name}`);

  for (const { node, parent } of nodes) {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression" || node.type.startsWith("Export"))
      throw new Error("Imports and exports are not supported in workflow bodies");
    if (node.type === "Identifier" && isReference(node, parent)) {
      const name = node.name as string;
      if (forbiddenGlobals.has(name)) throw new Error(`Workflow cannot access ${name}`);
      if (name === "Math") {
        if (parent?.type !== "MemberExpression" || parent.object !== node)
          throw new Error("Workflow may only use Math through a deterministic static property");
        const property = parent.property as Node;
        const propertyName = parent.computed ? (property.type === "Literal" ? property.value : undefined) : property.name;
        if (typeof propertyName !== "string" || !deterministicMathProperties.has(propertyName))
          throw new Error(`Workflow cannot access nondeterministic or unknown Math property ${String(propertyName)}`);
      }
      if (!declared.has(name) && !safeGlobals.has(name) && !injected.has(name)) throw new Error(`Unknown workflow global: ${name}`);
    }
    if (node.type === "MemberExpression") {
      const property = node.property as Node;
      const name = node.computed ? (property.type === "Literal" ? property.value : undefined) : property.name;
      if (typeof name === "string" && prototypeEscapeProperties.has(name))
        throw new Error(`Workflow cannot access prototype escape property ${name}`);
    }
  }
}

const anySchema = {};
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: true,
});

const prelude = `
const args = await tools.runtime.args({});
const agent = async (prompt, options = {}) => tools.runtime.agent({ ...options, prompt });
const phase = async (title) => tools.runtime.phase({ title });
const log = async (message) => tools.runtime.log({ message });
const checkpoint = async (prompt, options = {}) => tools.runtime.checkpoint({ ...options, prompt });
const workflow = async (name, workflowArgs) => workflowArgs === undefined
  ? tools.runtime.workflow({ name })
  : tools.runtime.workflow({ name, args: workflowArgs });
const MAX_HELPER_ITERATIONS = 1000;
const positiveInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HELPER_ITERATIONS)
    throw new RangeError(name + " must be a safe positive integer no greater than " + MAX_HELPER_ITERATIONS);
  return value;
};
const parallel = async (thunks) => Promise.all(thunks.map((thunk) => thunk()));
const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => {
  let value = item;
  for (const stage of stages) value = await stage(value);
  return value;
}));
const retry = async (thunk, options = {}) => {
  const attempts = positiveInteger(options.attempts === undefined ? 3 : options.attempts, "attempts");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await thunk(attempt); } catch (error) { lastError = error; }
  }
  throw lastError;
};
const gate = async (thunk, validator, options = {}) => retry(async (attempt) => {
  const value = await thunk(attempt);
  const verdict = await validator(value, attempt);
  const accepted = verdict === true || (verdict !== null && typeof verdict === "object" && verdict.ok === true);
  if (verdict !== true && verdict !== false && (verdict === null || typeof verdict !== "object" || typeof verdict.ok !== "boolean"))
    throw new TypeError("Workflow gate validator must return a boolean or { ok, feedback? }");
  if (!accepted) {
    const feedback = verdict !== null && typeof verdict === "object" && typeof verdict.feedback === "string" ? ": " + verdict.feedback : "";
    throw new Error("Workflow gate rejected the result" + feedback);
  }
  return value;
}, options);
const loopUntilDry = async ({ round, key, consecutiveEmpty = 2, maxRounds = 10 }) => {
  positiveInteger(consecutiveEmpty, "consecutiveEmpty");
  positiveInteger(maxRounds, "maxRounds");
  if (typeof round !== "function") throw new TypeError("loopUntilDry round must be a function");
  if (typeof key !== "function" && typeof key !== "string") throw new TypeError("loopUntilDry key must be a function or property name");
  const seen = new Set();
  const values = [];
  let empty = 0;
  for (let index = 1; index <= maxRounds && empty < consecutiveEmpty; index++) {
    const batch = await round(index);
    if (!Array.isArray(batch)) throw new TypeError("loopUntilDry round must return an array");
    let added = 0;
    for (const item of batch) {
      const identity = typeof key === "function" ? await key(item) : item[key];
      if (!seen.has(identity)) { seen.add(identity); values.push(item); added++; }
    }
    empty = added === 0 ? empty + 1 : 0;
  }
  return values;
};
`;

function positiveOption(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export async function executeWorkflowInterpreter(input: {
  script: string;
  args: unknown;
  signal: AbortSignal;
  host: WorkflowHost;
  maxCalls?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const { body } = parseWorkflow(input.script);
  validateBody(body);
  const maxCalls = positiveOption(input.maxCalls, "maxCalls");
  const timeoutMs = positiveOption(input.timeoutMs, "timeoutMs");
  if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
  let calls = 0;
  const pending = new Set<Promise<void>>();
  const safeMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
  const effect = <T>(operation: () => Promise<T>) => Effect.flatMap(
    Effect.promise(() => {
      const settled = operation().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
      );
      const completion = settled.then(() => {});
      pending.add(completion);
      void completion.then(() => pending.delete(completion));
      return settled;
    }),
    (settled) => settled.ok ? Effect.succeed(settled.value) : Effect.fail(toolError(safeMessage(settled.error))),
  );
  const call = <T>(operation: () => Promise<T>) => effect(async () => {
      calls++;
      if (maxCalls !== undefined && calls > maxCalls) throw new Error(`Workflow call limit exceeded (${maxCalls})`);
      return operation();
  });
  const tool = (description: string, schema: object, execute: (value: unknown) => Promise<unknown>, counted = true) =>
    Tool.make({
      description,
      input: schema,
      output: anySchema,
      execute: (value) => counted ? call(() => execute(value)) : effect(() => execute(value)),
    });
  const runtime = CodeMode.make({
    limits: { timeoutMs, maxOutputBytes: 1024 * 1024 },
    tools: { runtime: {
      args: tool("Return the workflow arguments", objectSchema({}), () => Promise.resolve(input.args), false),
      agent: tool("Run an agent", objectSchema({ prompt: { type: "string" } }, ["prompt"]), async (value) => {
        if (!isRecord(value) || typeof value.prompt !== "string") throw new TypeError("agent prompt must be a string");
        return input.host.agent(value);
      }),
      phase: tool("Enter a workflow phase", objectSchema({ title: { type: "string" } }, ["title"]), async (value) => {
        if (!isRecord(value) || typeof value.title !== "string") throw new TypeError("phase title must be a string");
        await input.host.phase(value.title); return null;
      }),
      log: tool("Write a workflow log message", objectSchema({ message: { type: "string" } }, ["message"]), async (value) => {
        if (!isRecord(value) || typeof value.message !== "string") throw new TypeError("log message must be a string");
        await input.host.log(value.message); return null;
      }),
      checkpoint: tool("Request a checkpoint", objectSchema({ prompt: { type: "string" }, key: { type: "string" } }, ["prompt", "key"]), async (value) => {
        if (!isRecord(value) || typeof value.prompt !== "string" || typeof value.key !== "string" || !value.key)
          throw new TypeError("checkpoint requires string prompt and key");
        return input.host.checkpoint(value);
      }),
      workflow: tool("Run a named workflow", objectSchema({ name: { type: "string" }, args: {} }, ["name"]), async (value) => {
        if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw new TypeError("workflow name must be a non-empty string");
        return input.host.workflow({ name: value.name, ...(Object.hasOwn(value, "args") ? { args: value.args } : {}) });
      }),
    } },
  });
  let result: CodeMode.Result;
  try {
    result = await Effect.runPromise(runtime.execute(`${prelude}\n${body}`), { signal: input.signal });
  } catch (error) {
    throw error;
  }
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  if (pending.size > 0) throw new Error("Workflow returned with unawaited host operations; await every agent and helper call");
  if (result.truncated || result.warnings?.some((warning) => warning.kind === "Truncated" || warning.kind === "TimeoutExceeded"))
    throw new Error("Workflow execution was truncated or timed out");
  const failedBackgroundWork = result.warnings?.find((warning) => warning.kind === "ToolFailure" || warning.kind === "ExecutionFailure");
  if (failedBackgroundWork) throw new Error(`${failedBackgroundWork.kind}: ${failedBackgroundWork.message}`);
  return result.value;
}
