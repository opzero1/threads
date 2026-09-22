import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / "workflows"
provider = Provider()
sandbox = None
terminal = None
checks = []


class WorkflowSandbox(Sandbox):
    def start(self):
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "README.md").write_text("Native workflow fixture\n")
            subprocess.run(["git", "add", "README.md"], cwd=self.directory, check=True)
            subprocess.run(["git", "-c", "user.name=Workflow fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture baseline"], cwd=self.directory, check=True, capture_output=True)
        super().start()


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def messages(session_id):
    return sandbox.api("GET", f"/api/session/{session_id}/message?limit=100")["data"]


def run_tool(session_id, name, arguments):
    def results():
        return [
            part for message in messages(session_id) if message["type"] == "assistant"
            for part in message["content"] if part["type"] == "tool" and part["name"] == name
            and part["state"]["status"] in ["completed", "error"]
        ]

    before = {part["id"] for part in results()}
    marker = f"FIXTURE_{uuid.uuid4().hex}"
    provider.responses[marker] = {"name": name, "arguments": arguments}
    sandbox.api("POST", f"/api/session/{session_id}/prompt", {"text": marker})
    output = eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60)
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"])
    return output


def decoded(part):
    assert part["state"]["status"] == "completed", part
    return json.loads(part["state"]["content"][0]["text"])


def inspect(owner, run_id):
    return sandbox.api("POST", "/api/rpc/workflows/inspect", {
        "input": {"ownerID": owner, "runID": run_id},
    }, location=sandbox.directory)["output"]


def settled(owner, run_id, status="completed"):
    def result():
        run = inspect(owner, run_id)
        if run["status"] == "failed" and status != "failed":
            raise AssertionError(run)
        return run if run["status"] == status else None
    return eventually(result, timeout=60)


def report(marker, result, wait=False):
    provider.responses[marker] = {"name": "workflows_result", "wait": wait, "arguments": {
        "verdict": "PASS", "summary": "Validated native fixture step", "evidence": ["deterministic native provider fixture"], "result": result,
    }}


def script(name, body):
    return f'export const meta = {{ name: "{name}", description: "Live workflow verification" }};\n{body}'


try:
    settings = config(target, provider)
    settings["agents"] = {
        "fixture-reader": {
            "mode": "subagent", "steps": 8, "model": "fixture/fixture",
            "system": "FIXTURE_WORKFLOW_READER. Return the assigned structured workflow result.",
            "permissions": [
                {"action": "*", "resource": "*", "effect": "deny"},
                {"action": "read", "resource": "*", "effect": "allow"},
            ],
        },
        "fixture-writer": {
            "mode": "subagent", "steps": 8, "system": "FIXTURE_WORKFLOW_WRITER.",
            "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
        },
    }
    sandbox = WorkflowSandbox(settings, artifacts)
    sandbox.await_plugin()
    owner = sandbox.api("POST", "/api/session", {
        "title": "Dynamic workflow verification", "location": {"directory": str(sandbox.directory)},
    })["data"]["id"]
    schema = {"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"], "additionalProperties": False}
    report("WORKFLOW_A", {"value": 1})
    report("WORKFLOW_B", {"value": 2})
    body = f'''await phase("Review");
return await pipeline(args.items, item => agent(item.prompt, {{
    key: item.key, agent: "fixture-reader", schema: {json.dumps(schema)}
}}));'''
    start = {"key": "native-parallel", "script": script("native-parallel", body), "args": {
        "items": [{"key": "a", "prompt": "WORKFLOW_A"}, {"key": "b", "prompt": "WORKFLOW_B"}],
    }}
    begun = decoded(run_tool(owner, "workflows_start", start))
    run = settled(owner, begun["id"])
    assert run["result"] == [{"value": 1}, {"value": 2}], run
    assert len(run["steps"]) == 2 and all(step["status"] == "completed" for step in run["steps"]), run
    assert all(step["model"]["providerID"] == "fixture" for step in run["steps"]), run
    assert any("FIXTURE_WORKFLOW_READER" in json.dumps(request) for request in provider.requests)
    passed("a native tool starts a background pipeline with named profiles and validated structured results")

    again = decoded(run_tool(owner, "workflows_start", start))
    assert again["id"] == begun["id"] and len(inspect(owner, begun["id"])["steps"]) == 2
    conflicting = run_tool(owner, "workflows_start", {**start, "args": {"items": []}})
    assert conflicting["state"]["status"] == "error", conflicting
    passed("exact start retries reuse the completed run and changed requests under its key fail")

    reader = run["steps"][0]["workerID"]
    forbidden = sandbox.directory / "forbidden-workflow-write"
    denied = run_tool(reader, "shell", {"command": f"touch '{forbidden}'"})
    assert denied["state"]["status"] == "error" and not forbidden.exists(), denied
    nested = run_tool(reader, "workflows_start", {**start, "key": "nested-forbidden"})
    assert nested["state"]["status"] == "error", nested
    passed("workflow readers cannot write or create another workflow")

    outsider = sandbox.api("POST", "/api/session", {"location": {"directory": str(sandbox.directory)}})["data"]["id"]
    denied = run_tool(outsider, "workflows_inspect", {"runID": begun["id"]})
    assert denied["state"]["status"] == "error", denied
    spoof = run_tool(outsider, "workflows_result", {"verdict": "PASS", "summary": "spoof", "evidence": [], "result": {}})
    assert spoof["state"]["status"] == "error", spoof
    passed("unrelated sessions cannot inspect a run through tools or forge worker results")

    invalid = decoded(run_tool(owner, "workflows_start", {
        "key": "invalid-schema", "script": script("invalid-schema", '''return await agent("Never run", {
            key: "bad", agent: "fixture-reader", schema: { type: "not-a-json-type" }
        });'''),
    }))
    failed = settled(owner, invalid["id"], "failed")
    assert not any(step["status"] == "completed" for step in failed["steps"]), failed
    passed("an invalid result schema fails without claiming a successful step")

    checkpoint = decoded(run_tool(owner, "workflows_start", {
        "key": "checkpoint", "script": script("checkpoint", '''const answer = await checkpoint("Choose a value", { key: "choice" });
        return { answer };'''),
    }))
    waiting = settled(owner, checkpoint["id"], "waiting")
    assert waiting["checkpoints"][0]["key"]
    resumed = decoded(run_tool(owner, "workflows_control", {
        "runID": checkpoint["id"], "action": "resume", "checkpointKey": waiting["checkpoints"][0]["key"], "response": 42,
    }))
    assert settled(owner, checkpoint["id"])["result"] == {"answer": 42}
    passed("a journaled checkpoint pauses and resumes with a structured response")

    saved = decoded(run_tool(owner, "workflows_save", {"runID": checkpoint["id"], "name": "saved-checkpoint", "scope": "project"}))
    assert Path(saved["path"]).read_text().startswith("export const meta"), saved
    catalog = decoded(run_tool(owner, "workflows_saved", {}))
    assert any(item["name"] == "saved-checkpoint" for item in catalog["workflows"]), catalog
    duplicate = run_tool(owner, "workflows_save", {"runID": checkpoint["id"], "name": "saved-checkpoint", "scope": "project"})
    assert duplicate["state"]["status"] == "error", duplicate
    passed("saved scripts are discoverable and an existing workflow file is not overwritten")

    provider.responses["WORKFLOW_WRITE"] = {"sequence": [
        {"name": "shell", "arguments": {"command": "printf 'verified isolated edit\\n' > workflow-proof.txt"}},
        {"name": "workflows_result", "arguments": {
            "verdict": "PASS", "summary": "Created isolated proof", "evidence": ["workflow-proof.txt"], "result": {"changed": "workflow-proof.txt"},
        }},
    ]}
    written = decoded(run_tool(owner, "workflows_start", {
        "key": "isolated-write", "script": script("isolated-write", '''return await agent("WORKFLOW_WRITE", {
            key: "write", agent: "fixture-writer", access: "write", isolation: "worktree"
        });'''),
    }))
    isolated = settled(owner, written["id"])
    checkout = Path(isolated["steps"][0]["directory"])
    assert checkout != sandbox.directory and (checkout / "workflow-proof.txt").read_text() == "verified isolated edit\n", isolated
    assert not (sandbox.directory / "workflow-proof.txt").exists()
    passed("an actual native writer edits a retained worktree without changing the coordinator checkout")

    report("WORKFLOW_PAUSE_FIRST", {"value": 3}, wait=True)
    report("WORKFLOW_PAUSE_SECOND", {"value": 4})
    paused_start = decoded(run_tool(owner, "workflows_start", {
        "key": "pause-resume", "concurrency": 1,
        "script": script("pause-resume", '''await agent("WORKFLOW_PAUSE_FIRST", { key: "first", agent: "fixture-reader" });
        return await agent("WORKFLOW_PAUSE_SECOND", { key: "second", agent: "fixture-reader" });'''),
    }))
    eventually(lambda: any("WORKFLOW_PAUSE_FIRST" in json.dumps(request) for request in provider.requests))
    decoded(run_tool(owner, "workflows_control", {"runID": paused_start["id"], "action": "pause"}))
    provider.release.set()
    paused = settled(owner, paused_start["id"], "paused")
    assert len(paused["steps"]) == 1, paused
    first_worker = paused["steps"][0]["workerID"]
    passed("pause drains active work and prevents the next dependent step from starting")

    provider.release.clear()
    report("WORKFLOW_STOP", {"value": 5}, wait=True)
    stopped_start = decoded(run_tool(owner, "workflows_start", {
        "key": "stop-active", "script": script("stop-active", '''return await agent("WORKFLOW_STOP", { key: "stop", agent: "fixture-reader" });'''),
    }))
    eventually(lambda: any("WORKFLOW_STOP" in json.dumps(request) for request in provider.requests))
    decoded(run_tool(owner, "workflows_control", {"runID": stopped_start["id"], "action": "stop"}))
    stopped = settled(owner, stopped_start["id"], "stopped")
    provider.release.set()
    active = sandbox.api("GET", "/api/session/active")["data"]
    assert all(step["workerID"] not in active for step in stopped["steps"]), stopped
    passed("stop interrupts native workers before settling the run")

    capped = decoded(run_tool(owner, "workflows_start", {
        "key": "bounded-agents", "maxAgents": 1,
        "script": script("bounded-agents", '''await agent("WORKFLOW_A", { key: "first", agent: "fixture-reader" });
        return await agent("WORKFLOW_B", { key: "second", agent: "fixture-reader" });'''),
    }))
    capped_run = settled(owner, capped["id"], "failed")
    assert len(capped_run["steps"]) == 1, capped_run
    passed("the run-wide agent limit blocks additional dispatch instead of silently truncating results")

    eventually(lambda: inspect(owner, capped["id"])["delivered"])
    eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"])
    before = len(provider.requests)
    sandbox.stop()
    sandbox.start()
    sandbox.await_plugin()
    recovered = inspect(owner, begun["id"])
    assert recovered["result"] == run["result"] and recovered["status"] == "completed", recovered
    assert len(provider.requests) == before
    passed("completed run results survive a real OpenCode service restart without new provider work")

    decoded(run_tool(owner, "workflows_control", {"runID": paused_start["id"], "action": "resume"}))
    resumed = settled(owner, paused_start["id"])
    assert resumed["steps"][0]["workerID"] == first_worker and resumed["result"] == {"value": 4}, resumed
    passed("resume after service restart reuses the completed worker and runs only the remaining step")

    terminal = Terminal(sandbox, owner)
    terminal.wait_for("Build · Fixture")
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Dynamic workflows")
    terminal.wait_for("native-parallel")
    passed("the actual TUI exposes the workflow navigator after server restart")
    os.write(terminal.master, b"native-parallel")
    terminal.wait_for("2/2 steps")
    os.write(terminal.master, b"\r")
    terminal.wait_for("p pause")
    terminal.wait_for("fixture-reader")
    os.write(terminal.master, b"f")
    terminal.wait_for("Result:")
    passed("the terminal panel renders worker reports and the final result with fullscreen control")
    (artifacts / "evidence.json").write_text(json.dumps({"checks": checks, "run": recovered, "providerRequests": len(provider.requests)}, indent=2))
finally:
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2))
    if terminal:
        terminal.close(artifacts / "tui.txt")
    if sandbox:
        sandbox.stop()
    provider.close()

print(json.dumps({"checks": checks, "artifacts": str(artifacts)}, indent=2))
