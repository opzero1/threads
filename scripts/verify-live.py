import json
from pathlib import Path
import sys
import uuid

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / ("live" if target == root else "live-package")
provider = Provider()
sandbox = None
terminal = None
checks = []


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def messages(session_id, kind=None):
    query = f"?type={kind}" if kind else ""
    return sandbox.api("GET", f"/api/session/{session_id}/message{query}")["data"]


def tool_results(session_id, name):
    return [
        part
        for message in messages(session_id)
        if message["type"] == "assistant"
        for part in message["content"]
        if part["type"] == "tool" and part["name"] == name
        and part["state"]["status"] in ["completed", "error"]
    ]


def run_tool(session_id, name, arguments):
    marker = f"FIXTURE_{uuid.uuid4().hex}"
    provider.responses[marker] = {"name": name, "arguments": arguments}
    before = {part["id"] for part in tool_results(session_id, name)}
    sandbox.api("POST", f"/api/session/{session_id}/prompt", {"text": marker})
    result = eventually(lambda: next((
        part for part in tool_results(session_id, name) if part["id"] not in before
    ), None), timeout=60)
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"])
    return result


def roots():
    return sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"]


try:
    settings = config(target, provider)
    sandbox = Sandbox(settings, artifacts)
    sandbox.api("POST", "/api/plugin/await-activation", location=sandbox.directory)
    plugins = sandbox.api("GET", "/api/plugin", location=sandbox.directory)["data"]
    installed = next(plugin for plugin in plugins if plugin["id"] == "op-threads")
    assert installed["state"]["status"] == "active", installed
    assert installed["features"].get("server") and installed["features"].get("tui"), installed
    passed("server and TUI entrypoints activate in isolated OpenCode 2.0.3")

    coordinator = sandbox.api("POST", "/api/session", {
        "title": "Fixture coordinator",
        "location": {"directory": str(sandbox.directory)},
        "permissions": [{"action": "shell", "resource": "*", "effect": "deny"}],
    })["data"]
    coordinator_id = coordinator["id"]
    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("Fixture coordinator", left=True)

    task = "FIXTURE_WORKER: perform the assigned local verification, then report."
    provider.responses["FIXTURE_WORKER"] = {
        "name": "threads_report",
        "arguments": {"verdict": "PASS", "summary": "Fixture delivery", "evidence": ["local fixture"]},
        "wait": True,
    }
    request = {"key": "worker-1", "title": "Visible fixture worker", "directory": str(sandbox.worker), "task": task}
    spawn = run_tool(coordinator_id, "threads_spawn", request)
    assert spawn["state"]["status"] == "completed", spawn
    workers = [session for session in roots() if session["id"] != coordinator_id]
    assert len(workers) == 1, workers
    worker = workers[0]
    worker_id = worker["id"]
    assert not worker.get("parentID"), worker
    assert worker["location"]["directory"] == str(sandbox.worker), worker
    assert worker["agent"] == coordinator.get("agent", "build"), worker
    assert worker["model"]["providerID"] == "fixture" and worker["model"]["id"] == "fixture", worker
    assert {"action": "shell", "resource": "*", "effect": "deny"} in worker.get("permissions", []), worker
    passed("spawn creates one independent worker in its assigned directory with inherited policy and model")

    eventually(lambda: worker_id in sandbox.api("GET", "/api/session/active")["data"])
    terminal.wait_for("Visible fixture worker", left=True)
    terminal.wait_for_match(lambda _: any(tab["sessionID"] == worker_id and tab["busy"] for tab in json.loads((artifacts / "tabs.json").read_text())["tabs"]), "running worker tab", 40, False)
    tab_state = json.loads((artifacts / "tabs.json").read_text())
    assert tab_state["route"] == {"type": "session", "sessionID": coordinator_id}, tab_state
    assert any(tab["sessionID"] == worker_id and tab["busy"] for tab in tab_state["tabs"]), tab_state
    passed("managed worker appears in the native TUI while its execution is running")
    passed("opening the worker tab preserves coordinator focus and its native busy indicator")
    hidden = run_tool(coordinator_id, "threads_hide", {"workerID": worker_id})
    assert hidden["state"]["status"] == "completed", hidden
    terminal.wait_for("threads_hide")
    tab_state = json.loads((artifacts / "tabs.json").read_text())
    assert any(tab["sessionID"] == worker_id and tab["busy"] for tab in tab_state["tabs"]), tab_state
    passed("an orchestrator hide request leaves a running worker visible")
    terminal.close(artifacts / "tui-visible.txt")
    terminal = None
    assert worker_id in sandbox.api("GET", "/api/session/active")["data"]
    passed("closing the TUI leaves the independent worker running")

    again = run_tool(coordinator_id, "threads_spawn", request)
    assert again["state"]["status"] == "completed", again
    assert len([session for session in roots() if session["id"] != coordinator_id]) == 1
    assert len(messages(worker_id, "user")) == 1
    passed("repeating a spawn key reuses the worker and its original prompt")

    conflict = run_tool(coordinator_id, "threads_spawn", {**request, "task": "Different work"})
    assert conflict["state"]["status"] == "error", conflict
    passed("a different task under an existing spawn key is rejected")

    stranger = sandbox.api("POST", "/api/session", {
        "title": "Unrelated coordinator", "location": {"directory": str(sandbox.directory)},
        "model": {"providerID": "fixture", "id": "fixture"},
    })["data"]
    unauthorized = run_tool(stranger["id"], "threads_send", {"workerID": worker_id, "key": "foreign", "text": "Do other work"})
    assert unauthorized["state"]["status"] == "error", unauthorized
    passed("unrelated coordinators cannot send work to another coordinator's worker")
    unauthorized_hide = run_tool(stranger["id"], "threads_hide", {"workerID": worker_id})
    assert unauthorized_hide["state"]["status"] == "error", unauthorized_hide
    passed("only the owning coordinator can hide a worker")

    provider.release.set()
    report = eventually(lambda: tool_results(worker_id, "threads_report"), timeout=60)[0]
    assert report["state"]["status"] == "completed", report
    eventually(lambda: any("Fixture delivery" in message.get("text", "") for message in messages(coordinator_id, "synthetic")))
    eventually(lambda: worker_id not in sandbox.api("GET", "/api/session/active")["data"])
    passed("worker report returns through the coordinator's durable synthetic inbox")

    repeat = run_tool(worker_id, "threads_report", {"verdict": "PASS", "summary": "Fixture delivery", "evidence": ["local fixture"]})
    assert repeat["state"]["status"] == "completed", repeat
    assert len([message for message in messages(coordinator_id, "synthetic") if "Fixture delivery" in message.get("text", "")]) == 1
    passed("retrying a delivered report does not duplicate the coordinator notification")

    changed_report = run_tool(worker_id, "threads_report", {"verdict": "FAIL", "summary": "Different result", "evidence": []})
    assert changed_report["state"]["status"] == "error", changed_report
    passed("a changed terminal report is rejected instead of silently replacing the original")

    forbidden_file = sandbox.worker / "forbidden-shell-output"
    denied = run_tool(worker_id, "shell", {"command": f"touch '{forbidden_file}'"})
    assert denied["state"]["status"] == "error" and not forbidden_file.exists(), denied
    passed("a worker cannot execute a shell command denied by the coordinator policy")

    listed = run_tool(coordinator_id, "threads_list", {})
    assert listed["state"]["status"] == "completed" and worker_id in json.dumps(listed), listed
    passed("the coordinator can list its persisted managed workers")

    followup = {"workerID": worker_id, "key": "clarify-1", "text": "Clarify the verification evidence already reported."}
    sent = run_tool(coordinator_id, "threads_send", followup)
    assert sent["state"]["status"] == "completed", sent
    eventually(lambda: worker_id not in sandbox.api("GET", "/api/session/active")["data"])
    prompts = len(messages(worker_id, "synthetic"))
    sent_again = run_tool(coordinator_id, "threads_send", followup)
    assert sent_again["state"]["status"] == "completed", sent_again
    assert len(messages(worker_id, "synthetic")) == prompts
    passed("coordinator follow-ups use stable message keys without duplicate prompts")

    send_conflict = run_tool(coordinator_id, "threads_send", {**followup, "text": "Different follow-up"})
    assert send_conflict["state"]["status"] == "error", send_conflict
    passed("reusing a follow-up key for different text is rejected")

    fake_report = run_tool(coordinator_id, "threads_report", {"verdict": "PASS", "summary": "Impersonation", "evidence": []})
    assert fake_report["state"]["status"] == "error", fake_report
    recursive = run_tool(worker_id, "threads_spawn", {**request, "key": "grandchild"})
    assert recursive["state"]["status"] == "error", recursive
    passed("only managed workers may report and they cannot spawn managed grandchildren")

    for caller_id, role in [(coordinator_id, "coordinator"), (worker_id, "managed worker")]:
        prompt = f"Return a short verification result to your {role}. Do not call any tools."
        delegated = run_tool(caller_id, "subagent", {
            "agent": "general", "description": f"Verify {role} delegation", "prompt": prompt,
        })
        assert delegated["state"]["status"] == "completed", delegated
        children = sandbox.api("GET", f"/api/session?parentID={caller_id}&limit=100")["data"]
        assert len(children) == 1 and children[0]["parentID"] == caller_id, children
        assert children[0]["location"]["directory"] == (str(sandbox.directory) if caller_id == coordinator_id else str(sandbox.worker)), children
        assert {"action": "shell", "resource": "*", "effect": "deny"} in children[0].get("permissions", []), children
        assert any(prompt in message.get("text", "") for message in messages(children[0]["id"], "user"))
        assert "Fixture completed." in json.dumps(delegated["state"]["content"]), delegated
        passed(f"the {role} can run a native subagent and receive its result with inherited directory and permissions")

    provider.release.clear()
    provider.responses["FIXTURE_INTERRUPT"] = {
        "name": "threads_report",
        "arguments": {"verdict": "PASS", "summary": "Should be interrupted", "evidence": []},
        "wait": True,
    }
    stopped_request = {**request, "key": "worker-2", "title": "Interrupt fixture worker", "task": "FIXTURE_INTERRUPT"}
    created = run_tool(coordinator_id, "threads_spawn", stopped_request)
    assert created["state"]["status"] == "completed", created
    stopped_id = next(session["id"] for session in roots() if session["title"] == "Interrupt fixture worker")
    eventually(lambda: stopped_id in sandbox.api("GET", "/api/session/active")["data"])
    stopped = run_tool(coordinator_id, "threads_interrupt", {"workerID": stopped_id})
    assert stopped["state"]["status"] == "completed", stopped
    eventually(lambda: stopped_id not in sandbox.api("GET", "/api/session/active")["data"])
    provider.release.set()
    assert not tool_results(stopped_id, "threads_report")
    passed("coordinator interruption stops a running worker without claiming a successful report")

    unreported = []
    for number in range(4):
        cap_request = {**request, "key": f"cap-{number}", "title": f"Capacity worker {number}", "task": "Finish the agent turn without reporting."}
        accepted = run_tool(coordinator_id, "threads_spawn", cap_request)
        assert accepted["state"]["status"] == "completed", accepted
        unreported.append(next(session["id"] for session in roots() if session["title"] == cap_request["title"]))
    overflow = run_tool(coordinator_id, "threads_spawn", {**request, "key": "overflow", "task": "Capacity overflow"})
    assert overflow["state"]["status"] == "error" and "limit" in json.dumps(overflow).lower(), overflow
    passed("four unreported workers fill the admission limit even after their agent turns succeed")

    sandbox.api("DELETE", f"/api/session/{unreported[0]}")
    after_delete = run_tool(coordinator_id, "threads_list", {})
    assert after_delete["state"]["status"] == "completed" and unreported[0] not in json.dumps(after_delete), after_delete
    replacement = run_tool(coordinator_id, "threads_spawn", {**request, "key": "replacement", "title": "Replacement worker", "task": "Finish without reporting."})
    assert replacement["state"]["status"] == "completed", replacement
    passed("deleted workers are removed from snapshots and release their admission slot")

    capacity_report = run_tool(unreported[1], "threads_report", {"verdict": "PASS", "summary": "Capacity task completed", "evidence": []})
    assert capacity_report["state"]["status"] == "completed", capacity_report
    hidden = run_tool(coordinator_id, "threads_hide", {"workerID": worker_id})
    assert hidden["state"]["status"] == "completed", hidden
    old_report_id = sandbox.api("GET", f"/api/session/{worker_id}")["data"]["metadata"]["opThreads"]["reportMessageID"]
    sandbox.api("DELETE", f"/api/session/{worker_id}")
    recreated = run_tool(coordinator_id, "threads_spawn", {**request, "task": "Finish without reporting."})
    assert recreated["state"]["status"] == "completed", recreated
    recreated_view = json.loads(next(item["text"] for item in recreated["state"]["content"] if item["type"] == "text"))
    assert recreated_view["workerID"] == worker_id and recreated_view["report"] is None and not recreated_view["hidden"], recreated_view
    fresh = sandbox.api("GET", f"/api/session/{worker_id}")["data"]
    assert fresh["metadata"]["opThreads"]["reportMessageID"] != old_report_id
    passed("recreating a deleted worker cannot inherit its old report or hidden state")

    before = len(messages(worker_id, "user"))
    sandbox.stop()
    sandbox.start()
    sandbox.api("POST", "/api/plugin/await-activation", location=sandbox.directory)
    assert len(messages(worker_id, "user")) == before
    assert worker_id not in sandbox.api("GET", "/api/session/active")["data"]
    passed("service restart preserves the relation without replaying worker tasks")

    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("Visible fixture worker", left=True)
    passed("a fresh TUI recovers the managed worker tab after a service restart")

    tool_names = {tool["function"]["name"] for request in provider.requests for tool in request.get("tools", [])}
    assert {"threads_spawn", "threads_list", "threads_send", "threads_interrupt", "threads_report", "subagent"} <= tool_names, tool_names
    passed("managed thread tools and native subagent are available together")
finally:
    if terminal:
        terminal.close(artifacts / "tui-recovered.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2) + "\n")
