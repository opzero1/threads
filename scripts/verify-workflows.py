import json
import hashlib
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


def source_hash():
    digest = hashlib.sha256()
    paths = [target / "index.ts", target / "tui.ts", target / "package.json", *sorted((target / "src").glob("*.ts")), *sorted((target / "src").glob("*.tsx"))]
    for path in paths:
        digest.update(str(path.relative_to(target)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


verified_source = source_hash()


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
        if run["status"] in ["completed", "failed", "stopped"] and run["status"] != status:
            raise AssertionError(run)
        return run if run["status"] == status else None
    return eventually(result, timeout=60)


def report(marker, result, wait=False):
    provider.responses[marker] = {"name": "workflows_result", "wait": wait, "arguments": {
        "verdict": "PASS", "summary": "Validated native fixture step", "evidence": ["deterministic native provider fixture"], "result": result,
    }}


def script(name, body):
    return f'export const meta = {{ name: "{name}", description: "Live workflow verification" }};\n{body}'


def close_workflow_panel():
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda display: "Dynamic workflows" not in display and "Build · Fixture" in display, "workflow panel closed", 40, False)


try:
    settings = config(target, provider)
    settings["plugins"].append(str(root / "scripts" / "workflow-probe"))
    settings["providers"]["fixture"]["models"]["role"] = {
        **settings["providers"]["fixture"]["models"]["fixture"], "name": "Role model",
        "variants": [{"id": "deep", "body": {"role_variant_probe": "deep"}}],
    }
    settings["agents"] = {
        "fixture-reader": {
            "mode": "subagent", "steps": 8, "model": "fixture/role#deep",
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
        "fixture-coordinator": {
            "mode": "primary", "steps": 8,
            "permissions": [{"action": "shell", "resource": "*", "effect": "deny"}],
        },
        "fixture-default-reader": {"mode": "subagent", "steps": 8},
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
    for step in run["steps"]:
        actual_model = sandbox.api("GET", f'/api/session/{step["workerID"]}')["data"]["model"]
        assert step["model"] == actual_model == {"providerID": "fixture", "id": "role", "variant": "deep"}, step
        assert any(part["name"] == "workflows_result" and part["state"]["status"] == "completed"
                   for message in messages(step["workerID"]) if message["type"] == "assistant"
                   for part in message["content"] if part["type"] == "tool"), step
    assert any(request.get("model") == "role" and request.get("role_variant_probe") == "deep" for request in provider.requests)
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

    broad = decoded(run_tool(owner, "workflows_start", {
        "key": "read-access-broad-profile", "script": script("read-access-broad-profile", '''return await agent("WORKFLOW_A", {
            key: "read", agent: "fixture-writer", access: "read"
        });'''),
    }))
    broad_run = settled(owner, broad["id"])
    denied = run_tool(broad_run["steps"][0]["workerID"], "workflow_probe_mutate", {})
    assert denied["state"]["status"] == "error" and not (sandbox.directory / "forbidden-plugin-write").exists(), denied
    passed("read access blocks unfamiliar side-effecting plugin tools even under a permissive profile")

    restricted_owner = sandbox.api("POST", "/api/session", {
        "agent": "fixture-coordinator", "location": {"directory": str(sandbox.directory)},
    })["data"]["id"]
    inherited = decoded(run_tool(restricted_owner, "workflows_start", {
        "key": "parent-agent-restriction", "script": script("parent-agent-restriction", '''return await agent("WORKFLOW_A", {
            key: "worker", agent: "fixture-writer", access: "write"
        });'''),
    }))
    inherited_run = settled(restricted_owner, inherited["id"])
    denied = run_tool(inherited_run["steps"][0]["workerID"], "shell", {"command": f"touch '{forbidden}'"})
    assert denied["state"]["status"] == "error" and not forbidden.exists(), denied
    passed("a workflow worker inherits restrictions from the coordinator agent as well as its session")

    provider.responses["WORKFLOW_DEFAULT_READ"] = {"sequence": [
        {"name": "read", "arguments": {"path": str(sandbox.directory / "README.md")}},
        {"name": "workflows_result", "arguments": {
            "verdict": "PASS", "summary": "Read fixture file", "evidence": ["README.md"], "result": "read",
        }},
    ]}
    default_read = decoded(run_tool(owner, "workflows_start", {
        "key": "default-read-rules", "script": script("default-read-rules", '''return await agent("WORKFLOW_DEFAULT_READ", {
            key: "read", agent: "fixture-default-reader"
        });'''),
    }))
    default_read_run = settled(owner, default_read["id"])
    reads = [part for message in messages(default_read_run["steps"][0]["workerID"]) if message["type"] == "assistant"
             for part in message["content"] if part["type"] == "tool" and part["name"] == "read"]
    assert len(reads) == 1 and reads[0]["state"]["status"] == "completed", reads
    assert "Native workflow fixture" in json.dumps(reads[0]["state"]["content"]), reads
    passed("a profile relying on default permissions retains its actual native read capability")

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

    provider.responses["WORKFLOW_REPAIR_RESULT"] = {"sequence": [
        {"name": "workflows_result", "arguments": {
            "verdict": "PASS", "summary": "First invalid attempt", "evidence": ["fixture"], "result": {"value": "wrong"},
        }},
        {"name": "workflows_result", "arguments": {
            "verdict": "PASS", "summary": "Repaired result", "evidence": ["fixture"], "result": {"value": 7},
        }},
    ]}
    repair = decoded(run_tool(owner, "workflows_start", {
        "key": "repair-result", "script": script("repair-result", f'''return await agent("WORKFLOW_REPAIR_RESULT", {{
            key: "repair", agent: "fixture-reader", schema: {json.dumps(schema)}
        }});'''),
    }))
    repaired = settled(owner, repair["id"])
    assert repaired["result"] == {"value": 7}, repaired
    report_attempts = [part for message in messages(repaired["steps"][0]["workerID"]) if message["type"] == "assistant"
                       for part in message["content"] if part["type"] == "tool" and part["name"] == "workflows_result"]
    report_attempts.sort(key=lambda part: part["time"]["created"])
    assert [part["state"]["status"] for part in report_attempts] == ["error", "completed"], report_attempts
    passed("native result validation rejects bad data and lets the original worker repair it")

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

    parallel_cap = decoded(run_tool(owner, "workflows_start", {
        "key": "parallel-agent-cap", "maxAgents": 1,
        "script": script("parallel-agent-cap", '''return await parallel([
            () => agent("WORKFLOW_A", { key: "one", agent: "fixture-reader" }),
            () => agent("WORKFLOW_B", { key: "two", agent: "fixture-reader" })
        ]);'''),
    }))
    cap_result = settled(owner, parallel_cap["id"], "failed")
    assert len(cap_result["steps"]) <= 1, cap_result
    eventually(lambda: all(step["workerID"] not in sandbox.api("GET", "/api/session/active")["data"] for step in cap_result["steps"]))
    passed("parallel agent admission cannot race past the shared run limit")

    tree_checkpoint = decoded(run_tool(owner, "workflows_start", {
        "key": "worktree-checkpoint", "script": script("worktree-checkpoint", '''const written = await agent("WORKFLOW_WRITE", {
            key: "write", agent: "fixture-writer", access: "write", isolation: "worktree"
        });
        await checkpoint("Inspect retained worktree", {key:"verified"}); return written;'''),
    }))
    tree_waiting = settled(owner, tree_checkpoint["id"], "waiting")

    eventually(lambda: inspect(owner, parallel_cap["id"])["delivered"])
    eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"])
    provider.release.clear()
    provider.responses["WORKFLOW_UNCERTAIN_WRITE"] = {"sequence": [
        {"name": "shell", "arguments": {"command": "printf 'one effect\\n' >> uncertain-write.txt"}},
        {"name": "workflows_result", "wait": True, "arguments": {
            "verdict": "PASS", "summary": "Write completed", "evidence": ["uncertain-write.txt"], "result": "written",
        }},
    ]}
    uncertain = decoded(run_tool(owner, "workflows_start", {
        "key": "uncertain-write", "script": script("uncertain-write", '''return await agent("WORKFLOW_UNCERTAIN_WRITE", {
            key: "write", agent: "fixture-writer", access: "write"
        });'''),
    }))
    effect = sandbox.directory / "uncertain-write.txt"
    eventually(lambda: effect.exists())
    uncertain_worker = eventually(lambda: next((step["workerID"] for step in inspect(owner, uncertain["id"])["steps"] if step["status"] == "running"), None))
    eventually(lambda: any(request.get("messages", []) and any(
        message.get("role") == "tool" and "one effect" not in str(message.get("content", ""))
        for message in request["messages"]
    ) and "WORKFLOW_UNCERTAIN_WRITE" in json.dumps(request) for request in provider.requests))
    before = len(provider.requests)
    sandbox.process.kill()
    sandbox.process.wait()
    sandbox.stop()
    provider.release.set()
    sandbox.start()
    sandbox.await_plugin()
    recovered = inspect(owner, begun["id"])
    assert recovered["result"] == run["result"] and recovered["status"] == "completed", recovered
    assert len(provider.requests) == before
    passed("completed run results survive a hard OpenCode service restart without new provider work")

    crashed = inspect(owner, uncertain["id"])
    assert crashed["status"] == "interrupted", crashed
    decoded(run_tool(owner, "workflows_control", {"runID": uncertain["id"], "action": "resume"}))
    reconciled = settled(owner, uncertain["id"], "interrupted")
    assert "uncertain" in reconciled["error"].lower(), reconciled
    assert effect.read_text() == "one effect\n"
    report("WORKFLOW_RESOLVE_WRITE", "written")
    decoded(run_tool(owner, "threads_send", {
        "workerID": uncertain_worker, "key": "explicit-write-resolution",
        "text": "WORKFLOW_RESOLVE_WRITE. The existing write was inspected and verified. Submit the result without repeating it.",
    }))
    eventually(lambda: uncertain_worker not in sandbox.api("GET", "/api/session/active")["data"])
    decoded(run_tool(owner, "workflows_control", {"runID": uncertain["id"], "action": "resume"}))
    resolved = settled(owner, uncertain["id"])
    assert resolved["steps"][0]["workerID"] == uncertain_worker and effect.read_text() == "one effect\n", resolved
    passed("a crash after a write requires explicit same-worker resolution and never duplicates the effect")

    decoded(run_tool(owner, "workflows_control", {
        "runID": tree_checkpoint["id"], "action": "resume", "checkpointKey": "verified", "response": True,
    }))
    tree_resumed = settled(owner, tree_checkpoint["id"])
    assert tree_resumed["steps"][0]["workerID"] == tree_waiting["steps"][0]["workerID"], tree_resumed
    assert tree_resumed["result"] == {"changed": "workflow-proof.txt"}, tree_resumed
    passed("a checkpoint resumes across a cold retained-worktree location without replaying its completed write")

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
    terminal.wait_for("2/2 recorded steps")
    os.write(terminal.master, b"\r")
    terminal.wait_for("s save")
    terminal.wait_for("fixture-reader")
    os.write(terminal.master, b"f")
    terminal.wait_for("Result:")
    passed("the terminal panel renders worker reports and the final result with fullscreen control")
    close_workflow_panel()
    ui_start = decoded(run_tool(owner, "workflows_start", {
        "key": "ui-checkpoint", "script": script("ui-checkpoint", 'return await checkpoint("Enter checkpoint response", {key:"ui"});'),
    }))
    settled(owner, ui_start["id"], "waiting")
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Dynamic workflows")
    os.write(terminal.master, b"ui-checkpoint")
    terminal.wait_for("ui-checkpoint · waiting")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Waiting: Enter checkpoint response")
    os.write(terminal.master, b"r")
    terminal.wait_for("JSON response")
    os.write(terminal.master, b"42")
    terminal.wait_for("42")
    os.write(terminal.master, b"\r")
    assert settled(owner, ui_start["id"])["result"] == 42
    passed("the terminal resume control supplies a checkpoint response to the live workflow")
    terminal.wait_for("ui-checkpoint · completed")
    os.write(terminal.master, b"s")
    terminal.wait_for("Save workflow")
    os.write(terminal.master, b"ui-saved")
    terminal.wait_for("ui-saved")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Save location")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Saved")
    assert (sandbox.directory / ".opencode/workflows/ui-saved.js").is_file()
    passed("the terminal save control writes a reusable workflow script")
    close_workflow_panel()
    provider.release.clear()
    report("WORKFLOW_UI_PAUSE", True, wait=True)
    ui_pause = decoded(run_tool(owner, "workflows_start", {
        "key": "ui-pause", "script": script("ui-pause", '''await agent("WORKFLOW_UI_PAUSE", {key:"held",agent:"fixture-reader"});
            return await checkpoint("Resume paused UI run", {key:"ui-resume"});'''),
    }))
    eventually(lambda: any(step["status"] == "running" for step in inspect(owner, ui_pause["id"])["steps"]))
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Dynamic workflows")
    os.write(terminal.master, b"ui-pause")
    terminal.wait_for("ui-pause · running")
    os.write(terminal.master, b"\r")
    terminal.wait_for("p pause")
    os.write(terminal.master, b"p")
    settled(owner, ui_pause["id"], "pausing")
    provider.release.set()
    settled(owner, ui_pause["id"], "paused")
    terminal.wait_for("ui-pause · paused")
    terminal.wait_for("Waiting: Resume paused UI run")
    os.write(terminal.master, b"r")
    terminal.wait_for("JSON response")
    os.write(terminal.master, b"true\r")
    assert settled(owner, ui_pause["id"])["result"] is True
    terminal.wait_for("ui-pause · completed")
    passed("the terminal pause key drains work and resumes its checkpoint")
    close_workflow_panel()
    provider.release.clear()
    report("WORKFLOW_UI_STOP", True, wait=True)
    ui_stop = decoded(run_tool(owner, "workflows_start", {
        "key": "ui-stop", "script": script("ui-stop", 'return await agent("WORKFLOW_UI_STOP", {key:"held",agent:"fixture-reader"});'),
    }))
    eventually(lambda: any(step["status"] == "running" for step in inspect(owner, ui_stop["id"])["steps"]))
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Dynamic workflows")
    os.write(terminal.master, b"ui-stop")
    terminal.wait_for("ui-stop · running")
    os.write(terminal.master, b"\r")
    terminal.wait_for("x stop")
    os.write(terminal.master, b"x")
    settled(owner, ui_stop["id"], "stopped")
    provider.release.set()
    terminal.wait_for("ui-stop · stopped")
    passed("the terminal stop key interrupts active workflow work")
    close_workflow_panel()
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Dynamic workflows")
    os.write(terminal.master, b"native-parallel")
    terminal.wait_for("2/2 recorded steps")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Enter open worker")
    os.write(terminal.master, b"\x1b[B")
    terminal.wait_for(f'› {recovered["steps"][1]["key"]}')
    os.write(terminal.master, b"\r")
    def selected_worker():
        try:
            return json.loads((artifacts / "tabs.json").read_text()).get("route", {}).get("sessionID") == recovered["steps"][1]["workerID"]
        except (FileNotFoundError, json.JSONDecodeError):
            return False
    eventually(selected_worker)
    passed("keyboard step selection opens the selected native worker conversation")
    assert source_hash() == verified_source, "Implementation changed during verification; rerun against the final source"
    (artifacts / "evidence.json").write_text(json.dumps({"checks": checks, "run": recovered, "providerRequests": len(provider.requests), "sourceHash": verified_source, "target": str(target)}, indent=2))
finally:
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2))
    if terminal:
        terminal.close(artifacts / "tui.txt")
    if sandbox:
        sandbox.stop()
    provider.close()

print(json.dumps({"checks": checks, "artifacts": str(artifacts)}, indent=2))
