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
  const [stepIndex, setStepIndex] = createSignal(0);
  const [error, setError] = createSignal("");
  const abort = new AbortController();
  let owner = "";
  let ownerGeneration = 0;
  let refreshInFlight: Promise<RefreshResult | undefined> | undefined;
  type OwnerContext = { ownerID: string; generation: number };
  type RefreshResult = { context: OwnerContext; runs: WorkflowSummary[] };
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
  function synchronizeOwner(): OwnerContext | undefined {
    const current = ownerID() ?? "";
    if (current !== owner) {
      owner = current;
      ownerGeneration += 1;
      setRuns([]);
      setSelected(undefined);
    }
    return current ? { ownerID: current, generation: ownerGeneration } : undefined;
  }
  function isCurrent(context: OwnerContext) {
    const current = synchronizeOwner();
    return !!current && current.ownerID === context.ownerID && current.generation === context.generation && !abort.signal.aborted;
  }
  function requestRefresh(context: OwnerContext) {
    let request!: Promise<RefreshResult | undefined>;
    request = (async () => {
      try {
        const snapshot = await rpc.snapshot({ ownerID: context.ownerID }, { location: location(), signal: abort.signal });
        if (!isCurrent(context)) return;
        setRuns(snapshot.runs);
        const id = selected()?.id;
        if (id) {
          const run = await rpc.inspect({ ownerID: context.ownerID, runID: id }, { location: location(), signal: abort.signal });
          if (!isCurrent(context)) return;
          if (selected()?.id === id) setSelected(run);
        }
        setError("");
        return { context, runs: snapshot.runs };
      } catch (cause) {
        if (isCurrent(context)) setError(String(cause));
      } finally {
        if (refreshInFlight === request) refreshInFlight = undefined;
      }
    })();
    refreshInFlight = request;
    return request;
  }
  function refreshInBackground() {
    const context = synchronizeOwner();
    if (!context || refreshInFlight || abort.signal.aborted) return;
    void requestRefresh(context);
  }
  async function refreshFresh() {
    synchronizeOwner();
    while (refreshInFlight) await refreshInFlight;
    const context = synchronizeOwner();
    if (!context || abort.signal.aborted) return;
    return requestRefresh(context);
  }
  async function openRun(id: string, expected = synchronizeOwner()) {
    if (!expected || !isCurrent(expected)) return;
    try {
      const run = await rpc.inspect({ ownerID: expected.ownerID, runID: id }, { location: location(), signal: abort.signal });
      if (!isCurrent(expected)) return;
      setSelected(run);
      setStepIndex(0);
      ctx.ui.panel.open("threads.workflows");
    } catch (cause) {
      ctx.ui.toast.show({ message: String(cause), variant: "error" });
    }
  }
  async function choose() {
    const fresh = await refreshFresh();
    if (!fresh || !isCurrent(fresh.context)) return;
    if (!fresh.runs.length) {
      ctx.ui.toast.show({ message: "No workflows yet. Use /workflow-run to describe a task.", variant: "info" });
      return;
    }
    const id = await ctx.ui.dialog.select({
      title: "Dynamic workflows",
      options: fresh.runs.map((run) => ({
        title: `${run.name} · ${run.status}`,
        description: `${run.counts.completed}/${run.counts.total} recorded steps · ${run.phase || "starting"} · ${run.usage.measured ? "" : "≥"}${run.usage.tokens} tokens`,
        value: run.id,
      })),
    });
    if (id && fresh.runs.some((run) => run.id === id) && isCurrent(fresh.context)) await openRun(id, fresh.context);
  }
  function canControl(action: "pause" | "resume" | "stop") {
    const run = selected();
    const status = run?.status;
    if (!status || run.ownerID !== ownerID()) return false;
    if (action === "pause") return status === "running";
    if (action === "resume") return status === "paused" || status === "interrupted" || status === "waiting";
    return status === "running" || status === "pausing" || status === "paused" || status === "interrupted" || status === "waiting";
  }
  async function control(action: "pause" | "resume" | "stop") {
    const run = selected();
    const context = synchronizeOwner();
    if (!run || !context || run.ownerID !== context.ownerID || !canControl(action)) return;
    try {
      const checkpoint = run.checkpoints.find((item) => item.response === undefined);
      let answer: Json | undefined;
      if (action === "resume" && checkpoint) {
        const text = await ctx.ui.dialog.prompt({ title: checkpoint.prompt, placeholder: "JSON response, for example true or a quoted string" });
        if (text === undefined) return;
        if (!isCurrent(context) || selected()?.id !== run.id) return;
        answer = Json.parse(JSON.parse(text));
      }
      const result = await rpc.control({
        ownerID: run.ownerID,
        runID: run.id,
        action,
        ...(checkpoint && action === "resume" ? { checkpointKey: checkpoint.key, response: answer } : {}),
      }, { location: location(), signal: abort.signal });
      if (!isCurrent(context) || selected()?.id !== run.id) return;
      setSelected(result);
      await refreshFresh();
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
      const moveStep = (delta: number) => {
        const length = selected()?.steps.length ?? 0;
        if (length) setStepIndex((index) => (index + delta + length) % length);
      };
      const openStep = () => {
        const step = selected()?.steps[stepIndex()];
        if (!step || step.status === "prepared") return;
        panel.close();
        ctx.ui.router.navigate({ type: "session", sessionID: step.workerID });
      };
      ctx.keymap.layer(() => ({ commands: panel.name === "threads.workflows" ? [
        { id: "workflows.pause", bind: "p", title: "Pause workflow", enabled: () => canControl("pause"), run: () => control("pause") },
        { id: "workflows.resume", bind: "r", title: "Resume workflow", enabled: () => canControl("resume"), run: () => control("resume") },
        { id: "workflows.stop", bind: "x", title: "Stop workflow", enabled: () => canControl("stop"), run: () => control("stop") },
        { id: "workflows.save", bind: "s", title: "Save workflow", run: save },
        { id: "workflows.previous-step", bind: "up", title: "Previous workflow step", run: () => moveStep(-1) },
        { id: "workflows.next-step", bind: "down", title: "Next workflow step", run: () => moveStep(1) },
        { id: "workflows.open-step", bind: "return", title: "Open workflow worker", run: openStep },
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
            <text>{[
              ...(canControl("pause") ? ["p pause"] : []),
              ...(canControl("resume") ? ["r resume"] : []),
              ...(canControl("stop") ? ["x stop"] : []),
              "s save", "f fullscreen", "Esc close",
            ].join(" · ")}</text>
            <Show when={run().steps.length > 0}><text>↑/↓ select step · Enter open worker</text></Show>
            <Show when={run().error}><text>{`Error: ${run().error}`}</text></Show>
            <For each={run().steps}>{(step, index) => <box flexDirection="column" border={true} padding={1} onMouseUp={() => { setStepIndex(index()); openStep(); }}>
              <text>{index() === stepIndex() ? "› " : "  "}<b>{step.input.label ?? step.key}</b>{` · ${step.status}`}</text>
              <text>{`${step.phase} · ${step.input.agent} · ${step.model.providerID}/${step.model.id}`}</text>
              <text>{ctx.ui.format.path(step.directory)}</text>
              <Show when={step.status === "completed" && step}>{(done: Accessor<Extract<WorkflowRun["steps"][number], { status: "completed" }>>) => <>
                <text>{`${done().report.verdict}: ${done().report.summary}`}</text>
                <text>{`${done().usage.measured ? "" : "unmeasured · "}${done().usage.tokens} tokens · $${done().usage.cost.toFixed(4)}`}</text>
                <For each={done().report.evidence}>{(evidence) => <text>{evidence}</text>}</For>
              </>}</Show>
              <Show when={step.status === "failed" && step}>{(failed: Accessor<Extract<WorkflowRun["steps"][number], { status: "failed" }>>) => <text>{failed().error}</text>}</Show>
              <text>{step.status === "prepared" ? "Waiting for worker admission" : "Click or select and press Enter to open worker"}</text>
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
      createEffect(() => { ownerID(); refreshInBackground(); });
      return <Show when={runs().find((run) => ["running", "pausing", "waiting"].includes(run.status))}>{(run: Accessor<WorkflowSummary>) =>
        <box onMouseUp={() => void openRun(run().id)}><text>{`Workflow ${run().name}: ${run().status} · ${run().counts.completed}/${run().counts.total} recorded steps · /workflows`}</text></box>
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
    if (details.type.startsWith("session.") || details.type.startsWith("rpc.workflows.")) refreshInBackground();
  });
  const timer = setInterval(refreshInBackground, 3000);
  return () => {
    abort.abort();
    clearInterval(timer);
    stopEvents();
    removePanel();
    removeFooter();
    removeCommands();
  };
}
