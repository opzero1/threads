import json
import os
from pathlib import Path
import subprocess
import sys
import time

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / ("tab-groups" if target == root else "tab-groups-package")
provider = Provider()
sandbox = None
terminal = None
checks = []


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def tab_state():
    try:
        return json.loads((artifacts / "tabs.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"tabs": [], "route": {}}


def wait_tabs(expected, selected, busy=(), attention=(), idle=(), ordered=True):
    def matches(_):
        state = tab_state()
        tabs = {tab["sessionID"]: tab for tab in state["tabs"]}
        return (
            (list(tabs) == expected if ordered else set(tabs) == set(expected))
            and state["route"].get("sessionID") == selected
            and all(tabs[sid]["busy"] for sid in busy)
            and all(tabs[sid]["attention"] for sid in attention)
            and all(not tabs[sid]["busy"] and not tabs[sid]["attention"] for sid in idle)
        )

    terminal.wait_for_match(matches, f"native tab state {expected}", 40, False)
    state = tab_state()
    terminal.wait_for_order([tab["title"] for tab in state["tabs"]])
    return state


def restore_tabs(expected, selected):
    os.write(terminal.master, b"/threads")
    terminal.wait_for("/threads")
    os.write(terminal.master, b"\r")
    return wait_tabs(expected, selected)


def worker_view(coordinator_id, worker_id):
    snapshot = sandbox.api("POST", "/api/rpc/threads/snapshot", {"input": {"coordinatorIDs": [coordinator_id]}}, location=sandbox.directory)
    return next(worker for worker in snapshot["output"]["workers"] if worker["workerID"] == worker_id)


try:
    sandbox = Sandbox(config(target, provider), artifacts)
    subprocess.run(["git", "init", "-b", "main", str(sandbox.directory)], check=True, capture_output=True)
    subprocess.run([
        "git", "-C", str(sandbox.directory), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "--allow-empty", "-m", "Fixture project",
    ], check=True, capture_output=True)
    worktree = sandbox.root / "alpha-worktree"
    subprocess.run(["git", "-C", str(sandbox.directory), "worktree", "add", "--detach", str(worktree)], check=True, capture_output=True)

    sessions = [sandbox.api("POST", "/api/session", {"title": title, "location": {"directory": str(directory)}})["data"] for title, directory in [
        ("Alpha coordinator", sandbox.directory),
        ("Beta coordinator", sandbox.worker),
        ("Alpha worktree", worktree),
        ("Beta review", sandbox.worker),
    ]]
    alpha, beta, alpha_worktree, beta_review = sessions
    assert alpha["projectID"] == alpha_worktree["projectID"] != beta["projectID"]
    assert beta["projectID"] == beta_review["projectID"]
    passed("real git worktrees share project identity across different directories")

    cli_path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"][0]["options"]["openSessionIDs"] = [session["id"] for session in sessions]
    cli["keybinds"] = {"session.tab.select.3": "f3", "session.tab.select.2": "f4"}
    cli_path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, alpha["id"])
    terminal.wait_for("ctrl+p commands")
    terminal.wait_for_match(lambda _: len(tab_state()["tabs"]) == 4, "four restored tabs", 40, False)
    os.write(terminal.master, b"\x07")
    expected_ids = [alpha["id"], alpha_worktree["id"], beta["id"], beta_review["id"]]
    state = wait_tabs(expected_ids, alpha["id"])
    assert [tab["sessionID"] for tab in state["tabs"]] == expected_ids, state
    assert state["route"] == {"type": "session", "sessionID": alpha["id"]}, state
    passed("interleaved native tabs become contiguous project groups without changing focus")
    passed("project groups and tabs within each group keep their original relative order")

    provider.responses["WORKER_REPORT"] = {
        "name": "threads_report",
        "arguments": {"verdict": "PASS", "summary": "Ordering fixture complete", "evidence": ["local TUI"]},
        "wait": True,
    }
    provider.responses["GROUP_WORKER"] = {
        "name": "threads_spawn",
        "arguments": {"key": "group-worker", "title": "Alpha new worker", "directory": str(worktree), "task": "WORKER_REPORT"},
    }
    sandbox.api("POST", f'/api/session/{alpha["id"]}/prompt', {"text": "GROUP_WORKER"})
    worker = eventually(lambda: next((session for session in sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"] if session["title"] == "Alpha new worker"), None))
    worker_id = worker["id"]
    running_ids = [alpha["id"], worker_id, alpha_worktree["id"], beta["id"], beta_review["id"]]
    wait_tabs(running_ids, alpha["id"], busy=[worker_id])
    passed("a running worker rises above idle tabs in its project without taking focus")

    provider.release.set()
    wait_tabs(expected_ids, alpha["id"], idle=[alpha["id"]])
    report_messages = sandbox.api("GET", f'/api/session/{alpha["id"]}/message?type=synthetic')["data"]
    assert any("Ordering fixture complete" in message.get("text", "") for message in report_messages)
    assert all(not message.get("description") for message in report_messages)
    assert "Worker report:" not in "\n".join(terminal.screen.display)
    assert "Ordering fixture complete" not in "\n".join(terminal.screen.display)
    passed("a successful report hides its idle worker without deleting the report or adding a parent notification row")

    grouped_ids = [alpha["id"], alpha_worktree["id"], worker_id, beta["id"], beta_review["id"]]
    restore_tabs(grouped_ids, alpha["id"])
    passed("the /threads command restores hidden workers for inspection")

    provider.release.clear()
    provider.responses["UNMANAGED_BUSY"] = {"name": "threads_list", "arguments": {}, "wait": True}
    sandbox.api("POST", f'/api/session/{alpha_worktree["id"]}/prompt', {"text": "UNMANAGED_BUSY"})
    grouped_ids = [alpha["id"], alpha_worktree["id"], worker_id, beta["id"], beta_review["id"]]
    wait_tabs(grouped_ids, alpha["id"], busy=[alpha_worktree["id"]], idle=[worker_id])
    passed("new activity in an unmanaged session moves it above a completed worker")
    provider.release.set()
    wait_tabs(grouped_ids, alpha["id"], idle=[alpha_worktree["id"], worker_id])

    provider.release.clear()
    provider.responses["RESUME_WORKER"] = {"name": "threads_list", "arguments": {}, "wait": True}
    sandbox.api("POST", f'/api/session/{worker_id}/prompt', {"text": "RESUME_WORKER"})
    wait_tabs(running_ids, alpha["id"], busy=[worker_id])
    passed("resuming a completed worker raises it above idle sessions again")
    provider.release.set()
    wait_tabs(running_ids, alpha["id"], idle=[worker_id])

    sandbox.api("PUT", f'/api/session/{beta_review["id"]}/permission/rules', {
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}],
    })
    provider.responses["ASK_PERMISSION"] = {"name": "shell", "arguments": {"command": "true"}}
    sandbox.api("POST", f'/api/session/{beta_review["id"]}/prompt', {"text": "ASK_PERMISSION"})
    attention_ids = [alpha["id"], worker_id, alpha_worktree["id"], beta_review["id"], beta["id"]]
    state = wait_tabs(attention_ids, alpha["id"], attention=[beta_review["id"]])
    (artifacts / "attention.json").write_text(json.dumps(state, indent=2) + "\n")
    passed("a native permission request rises above idle tabs without crossing project groups")

    terminal.close(artifacts / "grouped.txt")
    terminal = None
    cli["plugins"][0]["options"]["openSessionIDs"] = []
    cli_path.write_text(json.dumps(cli))
    request = sandbox.api("GET", f'/api/session/{beta_review["id"]}/permission')["data"][0]
    sandbox.api("POST", f'/api/session/{beta_review["id"]}/permission/{request["id"]}/reply', {"reply": "once"})
    eventually(lambda: beta_review["id"] not in sandbox.api("GET", "/api/session/active")["data"])
    (artifacts / "tabs.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, beta["id"])
    state = wait_tabs(running_ids, beta["id"], idle=[beta_review["id"]])
    passed("selecting an idle session raises it within its project after TUI reopening")
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 7, "two refresh intervals", 10, False)
    assert [tab["sessionID"] for tab in tab_state()["tabs"]] == running_ids
    passed("unchanged activity keeps the tab order stable across periodic refreshes")
    provider.responses["HIDE_WORKER"] = {"name": "threads_hide", "arguments": {"workerID": worker_id}}
    sandbox.api("POST", f'/api/session/{alpha["id"]}/prompt', {"text": "HIDE_WORKER"})
    wait_tabs(expected_ids, beta["id"])
    passed("the orchestrator can hide a restored idle worker without removing its conversation")
    assert sandbox.api("GET", f"/api/session/{worker_id}")["data"]["id"] == worker_id

    terminal.close(artifacts / "hidden.txt")
    terminal = None
    sandbox.stop()
    sandbox.start()
    (artifacts / "tabs.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, beta["id"])
    wait_tabs(expected_ids, beta["id"])
    passed("hidden workers stay hidden across server and TUI restarts")

    restore_tabs(grouped_ids, beta["id"])
    passed("hidden history remains restorable after a restart")
    os.write(terminal.master, b"\x1b[13~")
    selected_ids = [worker_id, alpha["id"], alpha_worktree["id"], beta["id"], beta_review["id"]]
    wait_tabs(selected_ids, worker_id, ordered=False)
    provider.responses["HIDE_SELECTED"] = {"name": "threads_hide", "arguments": {"workerID": worker_id}}
    sandbox.api("POST", f'/api/session/{alpha["id"]}/prompt', {"text": "HIDE_SELECTED"})
    eventually(lambda: worker_view(alpha["id"], worker_id)["hidden"])
    wait_tabs(selected_ids, worker_id, ordered=False)
    passed("hiding the selected worker preserves the open conversation")
    os.write(terminal.master, b"\x1b[14~")
    wait_tabs(expected_ids, alpha["id"], ordered=False)
    passed("a hidden selected worker closes once the user leaves it")
    provider.responses["FAIL_REPORT"] = {"name": "threads_report", "arguments": {"verdict": "FAIL", "summary": "Needs coordinator review", "evidence": []}}
    provider.responses["SPAWN_FAILED"] = {"name": "threads_spawn", "arguments": {"key": "failed-worker", "title": "Alpha failed worker", "directory": str(worktree), "task": "FAIL_REPORT"}}
    sandbox.api("POST", f'/api/session/{alpha["id"]}/prompt', {"text": "SPAWN_FAILED"})
    failed = eventually(lambda: next((session for session in sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"] if session["title"] == "Alpha failed worker"), None))
    eventually(lambda: worker_view(alpha["id"], failed["id"])["report"])
    terminal.wait_for_match(lambda _: any(tab["sessionID"] == failed["id"] and not tab["busy"] for tab in tab_state()["tabs"]), "failed worker stays visible", 40, False)
    assert not worker_view(alpha["id"], failed["id"])["hidden"]
    passed("a failed worker stays visible after reporting and becoming idle")
finally:
    if terminal:
        terminal.close(artifacts / "reopened.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
