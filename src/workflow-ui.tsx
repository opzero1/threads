import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { WorkflowsRpc } from "./workflow-rpc";
import { Json } from "./workflow-types";
import type { WorkflowRun, WorkflowSummary } from "./workflow-types";

export function workflowUI(ctx: Plugin.Context) {
  const rpc = ctx.client.rpc(WorkflowsRpc);
  const [runs, setRuns] = createSignal<WorkflowSummary[]>([]);
  const [selected, setSelected] = createSignal<WorkflowRun>();
  const [error, setError] = createSignal("");
  const abort = new AbortController();
  let busy = false;
  let owner = "";
  const location = () => ctx.location ?? ctx.data.location.default();
  function ownerID() {
    const route = ctx.ui.router.current();
    if (route.type !== "session") return undefined;
    const session = ctx.data.session.get(route.sessionID);
    const link = session?.metadata?.opThreads;
    return link && typeof link === "object" && "coordinatorID" in link && typeof link.coordinatorID === "string"
      ? link.coordinatorID
      : route.sessionID;
  }
  async function refresh() {
    const current = ownerID();
    if (!current || busy || abort.signal.aborted) return;
    if (current !== owner) {
      owner = current;
      setRuns([]);
      setSelected(undefined);
    }
    busy = true;
    try {
      const snapshot = await rpc.snapshot({ ownerID: current }, { location: location(), signal: abort.signal });
      if (current !== ownerID() || abort.signal.aborted) return;
      setRuns(snapshot.runs);
      const id = selected()?.id;
      if (id) {
        const run = await rpc.inspect({ ownerID: current, runID: id }, { location: location(), signal: abort.signal });
        if (current === ownerID() && !abort.signal.aborted) setSelected(run);
      }
      setError("");
    } catch (cause) {
      if (!abort.signal.aborted) setError(String(cause));
    } finally {
      busy = false;
    }
  }
  async function openRun(id: string) {
    const current = ownerID();
    if (!current) return;
    try {
      const run = await rpc.inspect({ ownerID: current, runID: id }, { location: location(), signal: abort.signal });
      if (current !== ownerID()) return;
      setSelected(run);
      ctx.ui.panel.open("threads.workflows");
    } catch (cause) {
      ctx.ui.toast.show({ message: String(cause), variant: "error" });
    }
  }
  async function choose() {
    await refresh();
    if (!runs().length) {
      ctx.ui.toast.show({ message: "No workflows yet. Use /workflow-run to describe a task.", variant: "info" });
      return;
    }
    const id = await ctx.ui.dialog.select({
      title: "Dynamic workflows",
      options: runs().map((run) => ({
        title: `${run.name} · ${run.status}`,
        description: `${run.counts.completed}/${run.counts.total} steps · ${run.phase || "starting"} · ${run.usage.measured ? "" : "≥"}${run.usage.tokens} tokens`,
        value: run.id,
      })),
    });
    if (id) await openRun(id);
  }
  async function control(action: "pause" | "resume" | "stop") {
    const run = selected();
    if (!run) return;
    try {
      const checkpoint = run.checkpoints.find((item) => item.response === undefined);
      let answer: Json | undefined;
      if (action === "resume" && checkpoint) {
        const text = await ctx.ui.dialog.prompt({ title: checkpoint.prompt, placeholder: "JSON response, for example true or a quoted string" });
        if (text === undefined) return;
        answer = Json.parse(JSON.parse(text));
      }
      const result = await rpc.control({
        ownerID: run.ownerID,
        runID: run.id,
        action,
        ...(checkpoint && action === "resume" ? { checkpointKey: checkpoint.key, response: answer } : {}),
      }, { location: location(), signal: abort.signal });
      setSelected(result);
      await refresh();
    } catch (cause) {
      ctx.ui.toast.show({ message: String(cause), variant: "error" });
    }
  }
  async function save() {
    const run = selected();
    if (!run) return;
    const name = await ctx.ui.dialog.prompt({ title: "Save workflow", placeholder: run.name });
    if (!name) return;
    const scope = await ctx.ui.dialog.select({ title: "Save location", options: [
      { title: "Project", value: "project" as const },
      { title: "User", value: "user" as const },
    ] });
    if (!scope) return;
    try {
      const output = await rpc.save({ ownerID: run.ownerID, runID: run.id, name, scope }, { location: location(), signal: abort.signal });
      ctx.ui.toast.show({ message: `Saved ${ctx.ui.format.path(output.path)}`, variant: "success" });
    } catch (cause) {
      ctx.ui.toast.show({ message: String(cause), variant: "error" });
    }
  }
  const removePanel = ctx.ui.slot({
    append: "session.panel",
    render: (panel) => {
      ctx.keymap.layer(() => ({ commands: panel.name === "threads.workflows" ? [
        { id: "workflows.pause", bind: "p", title: "Pause workflow", enabled: () => selected()?.status === "running", run: () => control("pause") },
        { id: "workflows.resume", bind: "r", title: "Resume workflow", run: () => control("resume") },
        { id: "workflows.stop", bind: "x", title: "Stop workflow", run: () => control("stop") },
        { id: "workflows.save", bind: "s", title: "Save workflow", run: save },
        { id: "workflows.fullscreen", bind: "f", title: "Toggle workflow fullscreen", run: panel.toggleFullscreen },
        { id: "workflows.close", bind: "escape", run: panel.close },
      ] : [] }));
      return <Show when={panel.name === "threads.workflows"}>
        <scrollbox flexGrow={1} padding={1}>
          <text><b>Dynamic workflows</b></text>
          <Show when={selected()}>{(run: Accessor<WorkflowRun>) => <box flexDirection="column" gap={1}>
            <text><b>{run().name}</b>{` · ${run().status}`}</text>
            <text>{run().description}</text>
            <text>{`Run: ${run().id}`}</text>
            <text>{`Phase: ${run().phase || "starting"}`}</text>
            <text>p pause · r resume · x stop · s save · f fullscreen · Esc close</text>
            <Show when={run().error}><text>{`Error: ${run().error}`}</text></Show>
            <For each={run().steps}>{(step) => <box flexDirection="column" border={true} padding={1} onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: step.workerID })}>
              <text><b>{step.input.label ?? step.key}</b>{` · ${step.status}`}</text>
              <text>{`${step.phase} · ${step.input.agent} · ${step.model.providerID}/${step.model.id}`}</text>
              <text>{ctx.ui.format.path(step.directory)}</text>
              <Show when={step.status === "completed" && step}>{(done: Accessor<Extract<WorkflowRun["steps"][number], { status: "completed" }>>) => <>
                <text>{`${done().report.verdict}: ${done().report.summary}`}</text>
                <text>{`${done().usage.measured ? "" : "unmeasured · "}${done().usage.tokens} tokens · $${done().usage.cost.toFixed(4)}`}</text>
                <For each={done().report.evidence}>{(evidence) => <text>{evidence}</text>}</For>
              </>}</Show>
              <Show when={step.status === "failed" && step}>{(failed: Accessor<Extract<WorkflowRun["steps"][number], { status: "failed" }>>) => <text>{failed().error}</text>}</Show>
              <text>Click to open worker session</text>
            </box>}</For>
            <For each={run().checkpoints}>{(checkpoint) => <text>{`${checkpoint.response === undefined ? "Waiting" : "Answered"}: ${checkpoint.prompt}`}</text>}</For>
            <For each={run().logs.slice(-30)}>{(entry) => <text>{entry.text}</text>}</For>
            <Show when={run().result !== undefined}><text>{`Result:\n${JSON.stringify(run().result, null, 2)}`}</text></Show>
          </box>}</Show>
          <Show when={error()}><text>{error()}</text></Show>
        </scrollbox>
      </Show>;
    },
  });
  const removeFooter = ctx.ui.slot({
    append: "session.composer.top",
    render: () => {
      createEffect(() => { ownerID(); void refresh(); });
      return <Show when={runs().find((run) => ["running", "pausing", "waiting"].includes(run.status))}>{(run: Accessor<WorkflowSummary>) =>
        <box onMouseUp={() => void openRun(run().id)}><text>{`Workflow ${run().name}: ${run().status} · ${run().counts.completed}/${run().counts.total} steps · /workflows`}</text></box>
      }</Show>;
    },
  });
  const removeCommands = ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({ mode: "global", commands: [{
        id: "workflows.open", title: "Open dynamic workflows", palette: true, slash: { name: "workflows" }, run: choose,
      }] }));
      return null;
    },
  });
  const stopEvents = ctx.data.listen(({ details }) => {
    if (details.type.startsWith("session.") || details.type.startsWith("rpc.workflows.")) void refresh();
  });
  const timer = setInterval(() => void refresh(), 3000);
  return () => {
    abort.abort();
    clearInterval(timer);
    stopEvents();
    removePanel();
    removeFooter();
    removeCommands();
  };
}
