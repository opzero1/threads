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


def shown(*parts):
    # The probe tree can lead the terminal; wait for the rendered text before saving evidence.
    wait(lambda: all(part in screen() for part in parts), f"{parts} on screen")


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


def picker_rows(node=None):
    node = node or state()["tree"]
    found = [node["id"]] if node.get("id", "").startswith("activity-picker-row-") else []
    for child in node["children"]:
        found += picker_rows(child)
    return found


def row(session_id):
    title = text(f"activity-picker-title-{session_id}")
    subtitle = text(f"activity-picker-subtitle-{session_id}")
    return None if title is None else {"title": title, "subtitle": subtitle, "y": rect(f"activity-picker-title-{session_id}")["y"]}


def footer_texts(node=None):
    # Text owned by this plugin's footer slot, so a native subagent indicator cannot satisfy a count.
    node = node if node is not None else rect("threads-footer")
    if node is None:
        return []
    return ([node["text"]] if node.get("text") else []) + [part for child in node["children"] for part in footer_texts(child)]


def owner_counts(description):
    wait(lambda: "1 worker" in footer_texts() and "? 1 needs input" in footer_texts()
         and "? 1 needs input" in footer() and "1 worker" in footer(), description)


def open_tab(title):
    # Native tabs have no stable IDs; select the vertical tab by its rendered title.
    pane = (rect("session-pane") or {}).get("x", 42)
    def tab(node):
        if node.get("text") == title and node.get("x", pane) < pane and node.get("width", 0) > 0:
            return node
        return next((found for child in node["children"] if (found := tab(child))), None)
    node = eventually(lambda: tab(state()["tree"]), timeout=10)
    x, y = node["x"] + 2, node["y"] + 1
    os.write(terminal.master, f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m".encode())


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
    coordinator = sandbox.api("POST", "/api/session", {"title": "[Main] Footer coordinator", "location": {"directory": str(sandbox.directory)}})["data"]
    local = sandbox.api("POST", "/api/session", {"title": "Local history", "location": {"directory": str(sandbox.directory)}})["data"]
    elsewhere = sandbox.api("POST", "/api/session", {"title": "Elsewhere history", "location": {"directory": str(sandbox.worker)}})["data"]
    coordinator_id = coordinator["id"]
    # Earlier lists showed the TUI folder's sessions, open tabs and their workers. These are
    # another conversation in that folder with its own worker, and an open tab from elsewhere.
    other = spawn(local["id"], "other", "Other thread worker", "Finish without reporting.")
    idle(other)
    idle(local["id"])
    assert worker_view(local["id"], other)["coordinatorID"] == local["id"]
    unrelated = [local["id"], elsewhere["id"], other]
    cli_path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"][0]["options"].update({"tree": True, "openSessionIDs": [elsewhere["id"]]})
    cli_path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("ctrl+p commands", timeout=60)
    wait(lambda: route() == coordinator_id and elsewhere["id"] in native_tabs(), "coordinator route with an unrelated open tab")
    pause(3)
    assert rect("threads-footer") is None and not indicator.search(footer()), footer()
    assert rect("op-threads-activity") is None
    save("idle-footer")
    passed(f"an idle TUI renders no Threads footer indicator and no Activity sidebar on OpenCode {sandbox.api('GET', '/api/info')['version']}")

    open_list()
    wait(lambda: row(coordinator_id) and category_y("Main") is not None and category_y("Main") < row(coordinator_id)["y"], "main conversation listed")
    shown("Threads · Footer coordinator", "> [Main] Footer coordinator", "ctrl+d Dismiss · enter Open · esc Close")
    assert "Threads · [Main]" not in screen() and "Local history" not in screen() and "Other thread worker" not in screen(), screen()
    assert picker_rows() == [f"activity-picker-row-{coordinator_id}"], picker_rows()
    assert all(row(id) is None for id in unrelated), [row(id) for id in unrelated]
    save("list-idle")
    close_list()
    passed("ctrl+x j opens the Threads list with only the current conversation, titled without its role prefix; other folder sessions, open tabs and other threads' workers stay out, and Escape closes it")
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

    # 0.2.6 before the scope fix counted every known worker, so this workerless tab showed the owner's footer.
    open_tab("Elsewhere history")
    wait(lambda: route() == elsewhere["id"], "unrelated conversation route")
    pause(3)
    assert rect("threads-footer") is None and not indicator.search(footer()), (footer_texts(), footer())
    save("elsewhere-footer")
    open_list()
    wait(lambda: row(elsewhere["id"]) and category_y("Main") is not None and category_y("Main") < row(elsewhere["id"])["y"], "unrelated conversation's own thread")
    shown("Threads · Elsewhere history", "> Elsewhere history")
    assert picker_rows() == [f"activity-picker-row-{elsewhere['id']}"], picker_rows()
    assert all(row(id) is None for id in (coordinator_id, one, two)), [row(id) for id in (coordinator_id, one, two)]
    assert "Footer worker one" not in screen() and "Footer worker two" not in screen() and "Running" not in screen(), screen()
    save("list-elsewhere")
    close_list()
    open_tab("[Main] Footer coordinator")
    wait(lambda: route() == coordinator_id, "coordinator route after the unrelated tab")
    owner_counts("owner footer counts after returning")
    assert two not in native_tabs() and one not in native_tabs(), native_tabs()
    save("owner-footer-returned")
    passed("another open conversation without workers shows no Threads footer and lists only its own main row, while the owner still shows 1 worker and 1 needs input")

    open_list()
    wait(lambda: row(one) and row(two), "worker rows")
    wait(lambda: (row(two)["subtitle"] or "").startswith("needs input") and (row(one)["subtitle"] or "").startswith("running"), "worker states")
    assert category_y("Needs attention") < row(two)["y"] < category_y("Running") < row(one)["y"] < category_y("Main") < row(coordinator_id)["y"], state()
    assert all(row(id) is None for id in unrelated), [row(id) for id in unrelated]
    wait(lambda: "Needs attention" in screen() and re.search(r"Footer worker two[ \t]+needs input\b", screen()), "grouped list on screen")
    save("list-running")
    passed("the list groups needs-attention and running workers above the main conversation and leaves other threads out")
    search("Footer worker one", one)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == one and one in native_tabs(), "selected worker tab")
    passed("keyboard selection opens and focuses the worker's tab")
    owner_counts("owner footer counts on the worker tab")
    save("worker-tab-footer")
    passed("the focused worker tab shows its owner's footer counts: 1 worker and 1 needs input")
    sandbox.api("POST", f"/api/session/{two}/permission/{request['id']}/reply", {"decision": "once"})
    idle(two)
    open_list()
    # The focused route is the worker, so the list must resolve its coordinator's thread.
    wait(lambda: row(coordinator_id) and row(one) and row(two) and (row(one)["title"] or "").startswith(">") and "Threads · Footer coordinator" in screen(), "coordinator's thread while its worker is focused")
    assert route() == one and "Threads · Footer worker one" not in screen(), route()
    assert category_y("Main") < row(coordinator_id)["y"], state()
    assert all(row(id) is None for id in unrelated), [row(id) for id in unrelated]
    shown("Threads · Footer coordinator", "> Footer worker one", "  Footer coordinator", "Footer worker two")
    assert "Local history" not in screen() and "Other thread worker" not in screen(), screen()
    save("list-worker-focused")
    passed("with a worker focused, the list shows its coordinator's thread: the main conversation and its workers, with the worker highlighted")
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
    assert category_y("Main") < row(coordinator_id)["y"] < category_y("Finished") < min(row(one)["y"], row(two)["y"]), state()
    wait(lambda: "Finished" in screen() and re.search(r"Footer worker one[ \t]+FAIL\b", screen()), "finished rows on screen")
    save("list-finished")
    passed("finished workers stay in the list under Finished with their verdict or native outcome")
    shown("> Footer coordinator", "[Main] Footer coordinator")
    assert "[Main] Footer coordinator" in "\n".join(line[:42] for line in terminal.screen.display), screen()
    assert sandbox.api("GET", f"/api/session/{coordinator_id}")["data"]["title"] == "[Main] Footer coordinator"
    passed("the saved coordinator title and its native tab keep the [Main] prefix, while the list shows the title without it")
    search("Footer worker one", one)
    wait(lambda: text(f"activity-picker-title-{one}") == "> Footer worker one" and text("activity-picker-hint") == "ctrl+d Dismiss · enter Open · esc Close", "highlighted title and hint without a pin")
    os.write(terminal.master, b"\x06")
    pause(1)
    assert text(f"activity-picker-title-{one}") == "> Footer worker one" and "Pin" not in text("activity-picker-hint"), (text(f"activity-picker-title-{one}"), text("activity-picker-hint"))
    assert rect("activity-picker") is not None and route() == coordinator_id
    os.write(terminal.master, b"\x04")
    wait(lambda: "Closed" in (row(one)["subtitle"] or "") and "Restore" in text("activity-picker-hint") and category_y("Closed") is not None, "dismiss from the list")
    os.write(terminal.master, b"\x04")
    wait(lambda: "Closed" not in (row(one)["subtitle"] or "") and category_y("Closed") is None, "restore from the list")
    assert rect("activity-picker") is not None and route() == coordinator_id
    close_list()
    passed("ctrl+d dismisses or restores the highlighted row without closing the list or changing focus; ctrl+f no longer pins and the hint omits Pin")

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
    wait(lambda: re.search(r"Footer worker three[ \t]+PASS\b", screen()), "restored worker on screen")
    save("threads-restore")
    close_list()
    passed("/threads restores a hidden PASS worker into the list without opening its tab")
    open_list()
    search("Footer worker two", two)
    os.write(terminal.master, b"\x04")
    wait(lambda: "Closed" in (row(two)["subtitle"] or "") and category_y("Closed") is not None and category_y("Closed") < row(two)["y"], "worker two dismissed before the restart")
    close_list()

    provider.release.clear()
    # FAIL keeps worker four visible, so only the list-opened rule can close its tab below.
    provider.responses["FOOTER_FOUR"] = {"name": "threads_report", "arguments": {"verdict": "FAIL", "summary": "Footer worker four failed", "evidence": ["fixture"]}, "wait": True}
    four = spawn(coordinator_id, "four", "Footer worker four", "FOOTER_FOUR")
    wait(lambda: "1 worker" in footer(), "running footer before home")
    os.write(terminal.master, b"\x18n")
    wait(lambda: state()["route"].get("type") == "home" and "1 worker" in footer(), "home footer indicator")
    save("home-footer")
    passed("the home footer shows running workers too")
    open_list()
    empty = "Open a conversation to see its workers"
    wait(lambda: text("activity-picker-empty") == empty and empty in screen(), "home list empty message")
    assert not picker_rows() and "Threads ·" not in screen(), (picker_rows(), screen())
    save("list-home")
    os.write(terminal.master, b"x")
    wait(lambda: text("activity-picker-empty") == "No matching conversations", "search on the empty home list")
    os.write(terminal.master, b"\x15")
    wait(lambda: text("activity-picker-empty") == empty, "home message after clearing the search")
    close_list()
    assert state()["route"].get("type") == "home"
    passed("on the home screen the list shows its open-a-conversation message instead of other conversations or the running worker")
    terminal.close(artifacts / "first.txt")
    terminal = None
    # Options left from earlier versions. Both are ignored, so every check below runs with them.
    # Version 0.2.5 honored workerTabs: "auto" and would open a tab for the running worker four.
    cli["plugins"].append({"package": str(target), "options": {"activity": "sidebar", "workerTabs": "auto"}})
    cli_path.write_text(json.dumps(cli))
    (artifacts / "tabs.json.tree.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, coordinator_id)
    terminal.wait_for("ctrl+p commands", timeout=60)
    wait(lambda: "1 worker" in footer(), "running footer after restart", 40)
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 7, "two missed-event refresh intervals", 10, False)
    assert four not in native_tabs() and one not in native_tabs() and three not in native_tabs(), native_tabs()
    assert len(indicator.findall(footer())) == 1, footer()
    left = "\n".join(line[:42] for line in terminal.screen.display)
    assert rect("op-threads-activity") is None and "Activity" not in left and "Elsewhere history" in left, left
    save("restart-legacy-options")
    passed('a fresh TUI started with leftover activity: "sidebar" and workerTabs: "auto" options shows the running worker once in the footer, adds no Activity rail, and opens no worker tab')
    open_list()
    wait(lambda: row(two) and "Closed" in (row(two)["subtitle"] or "") and category_y("Closed") is not None and category_y("Closed") < row(two)["y"], "dismissed worker still closed after the restart")
    shown("Closed", "· Closed")
    save("list-restart")
    close_list()
    command("/threads")
    wait(lambda: row(two) and "Closed" not in (row(two)["subtitle"] or "") and category_y("Closed") is None, "/threads restores the dismissed worker")
    assert two not in native_tabs(), native_tabs()
    close_list()
    passed("a dismissed worker stays under Closed after a TUI restart until /threads restores it")
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

    provider.release.clear()
    provider.responses["FOOTER_FIVE"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "Footer worker five passed", "evidence": ["fixture"]}, "wait": True}
    five = spawn(coordinator_id, "five", "Footer worker five", "FOOTER_FIVE")
    eventually(lambda: five in sandbox.api("GET", "/api/session/active")["data"])
    wait(lambda: "1 worker" in footer(), "running footer for a newly spawned worker")
    rails = []
    def no_tab_settled():
        if rect("op-threads-activity") is not None:
            rails.append(screen())
        return False
    settled = time.monotonic()
    wait(lambda: no_tab_settled() or time.monotonic() - settled >= 7, "two refresh intervals while the new worker runs", 15)
    assert five not in native_tabs() and route() == coordinator_id, (native_tabs(), route())
    assert not rails and rect("op-threads-activity") is None, rails
    open_list()
    wait(lambda: row(five) and row(coordinator_id) and (row(five)["subtitle"] or "").startswith("running") and category_y("Running") < row(five)["y"] < category_y("Main") < row(coordinator_id)["y"] and "Threads · Footer coordinator" in screen(), "thread list with the leftover options")
    assert all(row(id) is None for id in unrelated), [row(id) for id in unrelated]
    shown("Threads · Footer coordinator", "> Footer coordinator", "ctrl+d Dismiss · enter Open · esc Close")
    assert row(five)["subtitle"] == "running", row(five)
    assert "Local history" not in screen() and "Other thread worker" not in screen(), screen()
    save("legacy-options-list")
    close_list()
    passed('with a leftover workerTabs: "auto" option, a newly spawned running worker gets no tab, and the thread-only list shows it under Running')
    provider.release.set()
    eventually(lambda: (worker_view(coordinator_id, five)["report"] or {}).get("verdict") == "PASS", timeout=60)
    idle(five)
    wait(lambda: not indicator.search(footer()) and five not in native_tabs(), "footer cleared after the PASS worker", 30)
    # Worker one has reported, so this tab is not list-opened; only the hidden rule can close it.
    open_list()
    search("Footer worker one", one)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == one and one in native_tabs(), "reported worker tab opened from the list")
    provider.responses["FOOTER_HIDE_ONE"] = {"name": "threads_hide", "arguments": {"workerID": one}}
    sandbox.api("POST", f"/api/session/{coordinator_id}/prompt", {"text": "FOOTER_HIDE_ONE"})
    eventually(lambda: worker_view(coordinator_id, one)["hidden"], timeout=60)
    idle(coordinator_id)
    pause(4)
    assert route() == one and one in native_tabs(), (route(), native_tabs())
    open_list()
    search("Footer coordinator", coordinator_id)
    os.write(terminal.master, b"\r")
    wait(lambda: route() == coordinator_id and one not in native_tabs(), "hidden worker tab closed after focus moved away", 30)
    passed("a hidden worker's tab stays open while it is focused and closes once focus moves away")
    open_list()
    wait(lambda: row(two) is not None and row(one) is None, "worker two listed before its deletion")
    sandbox.api("DELETE", f"/api/session/{two}")
    wait(lambda: row(two) is None and row(coordinator_id) is not None, "deleted worker removed from the open list")
    assert rect("activity-picker") is not None and "Threads:" not in screen(), screen()
    close_list()
    passed("deleting a worker's session removes its row from the open list without an error")
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
