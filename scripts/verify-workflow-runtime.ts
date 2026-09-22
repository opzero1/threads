import { mkdir, writeFile } from "node:fs/promises";
import { executeWorkflow } from "../src/workflow-runtime";

const script = `export const meta = { name: "termination-soak", description: "CPU termination" };
await agent("ready"); while (true) { /^(a+)+$/.test(${JSON.stringify("a".repeat(34) + "!")}); }`;
const threads = () => Bun.spawnSync(["ps", "-M", "-p", String(process.pid)]).stdout.toString().trim().split("\n").length - 1;
let started = 0;

async function cycle() {
  const controller = new AbortController();
  let ready = false;
  try {
    await executeWorkflow({ script, args: null, signal: controller.signal, timeoutMs: 5000, host: {
      async agent() { ready = true; started++; setTimeout(() => controller.abort(new Error("soak-stop")), 25); return null; },
      async phase() {}, async log() {}, async checkpoint() { return null; }, async workflow() { return null; },
    } });
    throw new Error("CPU loop returned");
  } catch (error) {
    if (!ready || !(error instanceof Error) || error.message !== "soak-stop") throw error;
  }
}

if (process.platform !== "darwin") throw new Error("This native thread-count probe requires macOS ps -M");
for (let index = 0; index < 5; index++) await cycle();
await Bun.sleep(1000);
const warmThreads = threads();
for (let index = 0; index < 30; index++) await cycle();
await Bun.sleep(1000);
const finalThreads = threads();
const idleBefore = process.cpuUsage();
await Bun.sleep(1000);
const idleCpu = process.cpuUsage(idleBefore);
const result = { started, warmThreads, finalThreads, idleCpu, rss: process.memoryUsage().rss };
await mkdir(new URL("../.audit/runtime-soak/", import.meta.url), { recursive: true });
await writeFile(new URL("../.audit/runtime-soak/evidence.json", import.meta.url), JSON.stringify(result, null, 2));
if (finalThreads > warmThreads + 2) throw new Error(`Runtime worker threads leaked: ${JSON.stringify(result)}`);
if (idleCpu.user + idleCpu.system > 200_000) throw new Error(`CPU work survived runtime termination: ${JSON.stringify(result)}`);
console.log(JSON.stringify(result));
