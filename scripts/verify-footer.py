import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / ("footer" if target == root else "footer-package")
shutil.rmtree(artifacts, ignore_errors=True)
provider = Provider()
sandbox = None
terminal = None
checks = []
indicator = re.compile(r"\d+ workers?\b|\d+ workflows?\b|needs input")


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def state():
    try:
        return json.loads((artifacts / "tabs.json.tree.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"tree": {"id": "", "children": []}, "route": {}}


def find(node, id):
    if node.get("id") == id:
        return node
    for child in node["children"]:
        result = find(child, id)
        if result:
            return result


def rect(id):
    return find(state()["tree"], id)


def text(id):
    return (rect(id) or {}).get("text")


def native_tabs():
    try:
        return [tab["sessionID"] for tab in json.loads((artifacts / "tabs.json").read_text())["tabs"]]
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def route():
    return state()["route"].get("sessionID")


def screen():
    return "\n".join(terminal.screen.display)


def footer():
    return "\n".join(terminal.screen.display[-3:])


def save(name):
    (artifacts / f"{name}.screen.txt").write_text(screen())


def wait(check, description, timeout=20):
    terminal.wait_for_match(lambda _: check(), description, timeout, False)


def pause(seconds):
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= seconds, f"{seconds} s of terminal output", seconds + 10, False)


def command(name):
    os.write(terminal.master, name.encode())
    terminal.wait_for_match(lambda _: any(name in line[(rect("session-pane") or {}).get("x", 42):] for line in terminal.screen.display[-10:]), f"{name} in the native prompt", 10, False)
    os.write(terminal.master, b"\r")


def open_list(keys=b"\x18j"):
    os.write(terminal.master, keys)
    wait(lambda: "enter Open" in (text("activity-picker-hint") or ""), "Threads list hint")


def close_list():
    os.write(terminal.master, b"\x1b")
    wait(lambda: rect("activity-picker") is None, "Threads list closed")


def search(query, session_id):
    os.write(terminal.master, b"\x15" + query.encode())
    wait(lambda: (text(f"activity-picker-title-{session_id}") or "").startswith(">"), f"{query} highlighted")


def row(session_id):
    title = text(f"activity-picker-title-{session_id}")
    subtitle = text(f"activity-picker-subtitle-{session_id}")
    return None if title is None else {"title": title, "subtitle": subtitle, "y": rect(f"activity-picker-title-{session_id}")["y"]}


def category_y(name):
    node = rect(f"activity-picker-category-{name}")
    return node["y"] if node else None


def by_key(key):
    return next((session for session in sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"]
                 if session.get("metadata", {}).get("opThreads", {}).get("key") == key), None)


def worker_view(coordinator_id, worker_id):
    snapshot = sandbox.api("POST", "/api/rpc/threads/snapshot", {"input": {"coordinatorIDs": [coordinator_id]}}, location=sandbox.directory)
    return next(worker for worker in snapshot["output"]["workers"] if worker["workerID"] == worker_id)


def spawn(coordinator_id, key, title, task):
    marker = f"FOOTER_SPAWN_{key.upper().replace('-', '_')}"
    provider.responses[marker] = {"name": "threads_spawn", "arguments": {"key": key, "title": title, "directory": str(sandbox.worker), "task": task}}
    sandbox.api("POST", f"/api/session/{coordinator_id}/prompt", {"text": marker})
    return eventually(lambda: by_key(key), timeout=60)["id"]


def idle(session_id):
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"], timeout=60)


try:
    sandbox = Sandbox(config(target, provider), artifacts)
    coordinator = sandbox.api("POST", "/api/session", {"title": "Footer coordinator", "location": {"directory": str(sandbox.directory)}})["data"]
    local = sandbox.api("POST", "/api/session", {"title": "Local history", "location": {"directory": str(sandbox.directory)}})["data"]
    elsewhere = sandbox.api("POST", "/api/session", {"title": "Elsewhere history", "location": {"directory": str(sandbox.worker)}})["data"]
    coordinator_id = coordinator["id"]
    cli_path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"][0]["options"]["tree"] = True
    cli_path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("ctrl+p commands", timeout=60)
    wait(lambda: route() == coordinator_id, "coordinator route")
    pause(3)
    assert rect("threads-footer") is None and not indicator.search(footer()), footer()
    assert rect("op-threads-activity") is None
    save("idle-footer")
    passed(f"an idle TUI renders no Threads footer indicator and no Activity sidebar on OpenCode {sandbox.api('GET', '/api/info')['version']}")

    open_list()
    wait(lambda: row(local["id"]) and row(coordinator_id), "folder sessions listed")
    wait(lambda: "Threads ·" in screen() and "Recent" in screen(), "list text on screen")
    assert row(elsewhere["id"]) is None, row(elsewhere["id"])
    save("list-idle")
    close_list()
    passed("ctrl+x j opens the Threads list scoped to the TUI folder, and Escape closes it")
    command("/activities")
    wait(lambda: "enter Open" in (text("activity-picker-hint") or ""), "/activities list")
    close_list()
    passed("/activities opens the same list")

    provider.responses["FOOTER_ONE"] = {"name": "threads_report", "arguments": {"verdict": "FAIL", "summary": "Footer worker one failed", "evidence": ["fixture"]}, "wait": True}
    one = spawn(coordinator_id, "one", "Footer worker one", "FOOTER_ONE")
    eventually(lambda: one in sandbox.api("GET", "/api/session/active")["data"])
    wait(lambda: "1 worker" in footer() and (rect("threads-footer-spinner") or {}).get("width", 0) > 0, "running footer indicator")
    pause(2)
    assert one not in native_tabs() and route() == coordinator_id, (native_tabs(), route())
    save("running-footer")
    passed("a running worker shows the footer spinner and count without opening its tab or taking focus")

    two = spawn(coordinator_id, "two", "Footer worker two", "Finish without reporting.")
    idle(two)
    sandbox.api("PATCH", f"/api/session/{two}", {"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
    provider.responses["FOOTER_ASK"] = {"name": "shell", "arguments": {"command": "true"}}
    sandbox.api("POST", f"/api/session/{two}/prompt", {"text": "FOOTER_ASK"})
    request = eventually(lambda: next(iter(sandbox.api("GET", f"/api/session/{two}/permission")["data"]), None))
    wait(lambda: "? 1 needs input" in footer() and "1 worker" in footer(), "attention marker")
    assert two not in native_tabs()
    save("attention-footer")
    passed("a worker waiting for permission adds an attention marker instead of a second running count")

    open_list()
    wait(lambda: row(one) and row(two), "worker rows")
    wait(lambda: (row(two)["subtitle"] or "").startswith("needs input") and (row(one)["subtitle"] or "").startswith("running"), "worker states")
    assert category_y("Needs attention") < row(two)["y"] < category_y("Running") < row(one)["y"] < category_y("Recent") < row(coordinator_id)["y"], state()
    wait(lambda: "Needs attention" in screen() and "needs input ·" in screen(), "grouped list on screen")
    save("list-running")
    passed("the list groups needs-attention and running workers above recent conversations")
    search("Footer worker one", one)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == one and one in native_tabs(), "selected worker tab")
    passed("keyboard selection opens and focuses the worker's tab")
    sandbox.api("POST", f"/api/session/{two}/permission/{request['id']}/reply", {"decision": "once"})
    idle(two)
    open_list()
    # The focused worker runs in another folder, so ctx.location now names that folder.
    wait(lambda: row(local["id"]) and row(coordinator_id) and row(one) and "Threads · ~/coordinator" in screen(), "TUI folder list while a worker from another folder is focused")
    assert route() == one and row(elsewhere["id"]) is None and "Threads · ~/worker" not in screen(), (route(), row(elsewhere["id"]))
    save("list-worker-focused")
    passed("with a worker from another folder focused, the list stays scoped to the TUI folder")
    search("Footer coordinator", coordinator_id)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == coordinator_id, "coordinator route")
    assert one in native_tabs() and two not in native_tabs(), native_tabs()
    passed("the list returns to the coordinator while the running worker's opened tab stays open")

    provider.responses["FOOTER_FORM"] = {"name": "question", "arguments": {"questions": [{"question": "Continue the footer check?", "header": "Footer check", "options": [{"label": "Continue", "description": "Answer the fixture form"}]}]}}
    sandbox.api("POST", f"/api/session/{two}/prompt", {"text": "FOOTER_FORM"})
    form = eventually(lambda: next(iter(sandbox.api("GET", f"/api/session/{two}/form")["data"]), None))
    wait(lambda: "? 1 needs input" in footer() and "1 worker" in footer(), "form attention marker")
    assert two not in native_tabs() and route() == coordinator_id, (native_tabs(), route())
    save("form-footer")
    sandbox.api("POST", f"/api/session/{two}/form/{form['id']}/reply", {"answer": {"q0": "Continue"}})
    idle(two)
    wait(lambda: "needs input" not in footer() and "1 worker" in footer(), "form marker cleared")
    passed("a worker waiting for a form answer gets the same attention marker without opening its tab, and the marker clears once answered")

    provider.release.set()
    eventually(lambda: (worker_view(coordinator_id, one)["report"] or {}).get("verdict") == "FAIL", timeout=60)
    idle(one)
    wait(lambda: one not in native_tabs(), "reported worker tab closed", 30)
    assert route() == coordinator_id and not worker_view(coordinator_id, one)["hidden"]
    eventually(lambda: any("Footer worker one failed" in message.get("text", "") for message in sandbox.api("GET", f"/api/session/{coordinator_id}/message?type=synthetic")["data"]))
    wait(lambda: not indicator.search(footer()), "footer cleared")
    passed("a list-opened worker tab closes once its report is delivered and it is not focused; the footer clears")

    open_list()
    wait(lambda: row(one) and (row(one)["subtitle"] or "").startswith("FAIL") and (row(two)["subtitle"] or "").startswith("no report"), "finished rows")
    assert category_y("Finished") < row(one)["y"] and category_y("Finished") < row(two)["y"] < category_y("Recent")
    wait(lambda: "Finished" in screen() and "FAIL ·" in screen(), "finished rows on screen")
    save("list-finished")
    passed("finished workers stay in the list under Finished with their verdict or native outcome")
    search("Footer worker one", one)
    os.write(terminal.master, b"\x06")
    wait(lambda: text(f"activity-picker-title-{one}") == "> ◆ Footer worker one" and "Unpin" in text("activity-picker-hint"), "pin from the list")
    os.write(terminal.master, b"\x06")
    wait(lambda: text(f"activity-picker-title-{one}") == "> ◇ Footer worker one", "unpin from the list")
    os.write(terminal.master, b"\x04")
    wait(lambda: "Closed" in (row(one)["subtitle"] or "") and "Restore" in text("activity-picker-hint") and category_y("Closed") is not None, "dismiss from the list")
    os.write(terminal.master, b"\x04")
    wait(lambda: "Closed" not in (row(one)["subtitle"] or "") and category_y("Closed") is None, "restore from the list")
    assert rect("activity-picker") is not None and route() == coordinator_id
    close_list()
    passed("ctrl+f pins and ctrl+d dismisses or restores the highlighted row without closing the list or changing focus")

    provider.responses["FOOTER_THREE"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "Footer worker three passed", "evidence": ["fixture"]}}
    three = spawn(coordinator_id, "three", "Footer worker three", "FOOTER_THREE")
    eventually(lambda: worker_view(coordinator_id, three)["hidden"], timeout=60)
    idle(three)
    idle(coordinator_id)
    open_list()
    wait(lambda: row(one) is not None and row(three) is None, "hidden PASS worker left out of the list", 30)
    close_list()
    command("/threads")
    wait(lambda: row(three) and (row(three)["subtitle"] or "").startswith("PASS"), "/threads restores the hidden worker into the list")
    assert not worker_view(coordinator_id, three)["hidden"] and three not in native_tabs()
    wait(lambda: "PASS ·" in screen(), "restored worker on screen")
    save("threads-restore")
    close_list()
    passed("/threads restores a hidden PASS worker into the list without opening its tab")

    provider.release.clear()
    # FAIL keeps worker four visible, so only the list-opened rule can close its tab below.
    provider.responses["FOOTER_FOUR"] = {"name": "threads_report", "arguments": {"verdict": "FAIL", "summary": "Footer worker four failed", "evidence": ["fixture"]}, "wait": True}
    four = spawn(coordinator_id, "four", "Footer worker four", "FOOTER_FOUR")
    wait(lambda: "1 worker" in footer(), "running footer before home")
    os.write(terminal.master, b"\x18n")
    wait(lambda: state()["route"].get("type") == "home" and "1 worker" in footer(), "home footer indicator")
    save("home-footer")
    passed("the home footer shows running workers too")
    terminal.close(artifacts / "first.txt")
    terminal = None
    (artifacts / "tabs.json.tree.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("ctrl+p commands", timeout=60)
    wait(lambda: "1 worker" in footer(), "running footer after restart", 40)
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 7, "two missed-event refresh intervals", 10, False)
    assert four not in native_tabs() and one not in native_tabs() and three not in native_tabs(), native_tabs()
    passed("a fresh TUI shows the running worker in the footer and still opens no worker tabs")
    open_list()
    search("Footer worker four", four)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == four and four in native_tabs(), "list-opened tab of the running worker")
    provider.release.set()
    eventually(lambda: (worker_view(coordinator_id, four)["report"] or {}).get("verdict") == "FAIL", timeout=60)
    idle(four)
    wait(lambda: not indicator.search(footer()), "footer cleared after the last worker", 30)
    passed("the indicator disappears when the last worker finishes")
    pause(4)
    assert route() == four and four in native_tabs(), (route(), native_tabs())
    save("reported-tab-focused")
    passed("a reported worker's list-opened tab stays open while it is focused")
    open_list()
    search("Footer coordinator", coordinator_id)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == coordinator_id and four not in native_tabs(), "list-opened tab closed after focus moved away", 30)
    assert not worker_view(coordinator_id, four)["hidden"]
    passed("that tab closes once focus moves to another conversation")

    cli["plugins"].append({"package": str(target), "options": {"activity": "sidebar"}})
    cli_path.write_text(json.dumps(cli))
    wait(lambda: rect("op-threads-activity") is not None and rect("op-threads-activity")["width"] > 0, "Activity sidebar option", 30)
    terminal.wait_for("Activity", left=True)
    save("sidebar-option")
    passed("the activity: sidebar option restores the Activity sidebar")
    cli["plugins"][-1]["options"] = {"activity": "footer", "workerTabs": "auto"}
    cli_path.write_text(json.dumps(cli))
    wait(lambda: rect("op-threads-activity") is None, "sidebar detached", 30)
    provider.release.clear()
    provider.responses["FOOTER_FIVE"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "Footer worker five passed", "evidence": ["fixture"]}, "wait": True}
    five = spawn(coordinator_id, "five", "Footer worker five", "FOOTER_FIVE")
    wait(lambda: five in native_tabs(), "automatic worker tab", 30)
    assert route() == coordinator_id
    provider.release.set()
    wait(lambda: five not in native_tabs(), "PASS worker tab hidden", 40)
    passed("the workerTabs: auto option restores automatic tabs for running workers without taking focus")
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
