import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

from fixture import Provider, config, tool_call
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = Path(os.environ["THREADS_ARTIFACT_DIR"]).resolve() if "THREADS_ARTIFACT_DIR" in os.environ else root / ".audit" / ("footer" if target == root else "footer-package")
artifacts.mkdir(parents=True, exist_ok=False)
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


def texts(node=None):
    node = node if node is not None else state()["tree"]
    # Text renderables have a foreground; an input's value does not.
    own = [node] if node.get("text") and node.get("fg") is not None else []
    return own + [text for child in node["children"] for text in texts(child)]


def dialog(title):
    # A native dialog's title row ends with its "esc" label.
    nodes = texts()
    head = next((node for node in nodes if title(node["text"]) and any(
        other["text"] == "esc" and other["y"] == node["y"] and other["x"] > node["x"] for other in nodes)), None)
    if head is None:
        return None
    below = sorted((node for node in nodes if node["x"] == head["x"] and node["y"] > head["y"]), key=lambda node: node["y"])
    current = next((node["y"] for node in nodes if node["text"] == "●" and node["x"] < head["x"] and node["y"] > head["y"]), None)
    return {"title": head["text"], "options": below, "current": current}


def listing():
    return dialog(lambda text: text == "Threads" or text.startswith("Threads · "))


option = re.compile(r"(.+) ((?:Needs attention|Running|Main|Finished|Closed)(?: · (?:needs input|running|starting|no report|failed|interrupted|PASS WITH NOTES|PASS|FAIL|INCONCLUSIVE))?)")


def rows():
    found = listing()
    return [{"title": match[1], "description": match[2], "y": node["y"], "current": node["y"] == found["current"]}
            for node in (found["options"] if found else []) if (match := option.fullmatch(node["text"]))]


def titles():
    return [item["title"] for item in rows()]


def row(title):
    return next((item for item in rows() if item["title"] == title), None)


def description(title):
    return (row(title) or {}).get("description")


def current():
    return next((item["title"] for item in rows() if item["current"]), None)


def menu(title):
    found = dialog(lambda text: text == title)
    return [node["text"] for node in found["options"] if node["text"] in ("Open", "Dismiss", "Restore")] if found else None


def open_list(keys=b"\x18j"):
    os.write(terminal.master, keys)
    wait(lambda: rows(), "Threads list rows")


def close_list():
    os.write(terminal.master, b"\x1b")
    wait(lambda: listing() is None, "Threads list closed")


def search(title):
    os.write(terminal.master, b"\x15" + title.encode())
    wait(lambda: titles()[:1] == [title], f"{title} first in the list")


def choose(title, action):
    # Selecting a row opens a native menu: Open and either Dismiss or Restore.
    search(title)
    os.write(terminal.master, b"\r")
    wait(lambda: (menu(title) or [])[:1] == ["Open"] and (action == "Open" or menu(title) == ["Open", action]), f"{title} menu with {action}")
    os.write(terminal.master, action.encode())
    wait(lambda: menu(title) == [action], f"{action} filtered")
    os.write(terminal.master, b"\r")
    wait(lambda: menu(title) is None and listing() is None, f"{title} menu closed")


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
    sandbox.await_plugin()
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
    wait(lambda: titles() == ["[Main] Footer coordinator"] and description("[Main] Footer coordinator") == "Main", "main conversation listed")
    shown("Threads · Footer coordinator", "[Main] Footer coordinator Main")
    assert current() == "[Main] Footer coordinator", rows()
    assert "Threads · [Main]" not in screen() and "Local history" not in screen() and "Other thread worker" not in screen(), screen()
    save("list-idle")
    close_list()
    passed("ctrl+x j opens the native Threads list with only the current conversation, headed by its title without the role prefix; other folder sessions, open tabs and other threads' workers stay out, and Escape closes it")
    command("/activities")
    wait(lambda: rows(), "/activities list")
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
    wait(lambda: titles() == ["Elsewhere history"] and description("Elsewhere history") == "Main", "unrelated conversation's own thread")
    shown("Threads · Elsewhere history", "Elsewhere history Main")
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
    wait(lambda: description("Footer worker two") == "Needs attention · needs input" and description("Footer worker one") == "Running · running", "worker states")
    assert titles() == ["Footer worker two", "Footer worker one", "Footer coordinator"] and description("Footer coordinator") == "Main", rows()
    shown("Footer worker two Needs attention · needs input", "Footer worker one Running · running")
    save("list-running")
    passed("the list orders needs-attention and running workers above the main conversation, with category and state in each description, and leaves other threads out")
    choose("Footer worker one", "Open")
    wait(lambda: route() == one and one in native_tabs(), "selected worker tab")
    passed("Open from a row's menu opens and focuses the worker's tab")
    owner_counts("owner footer counts on the worker tab")
    save("worker-tab-footer")
    passed("the focused worker tab shows its owner's footer counts: 1 worker and 1 needs input")
    sandbox.api("POST", f"/api/session/{two}/permission/{request['id']}/reply", {"decision": "once"})
    idle(two)
    open_list()
    # The focused route is the worker, so the list must resolve its coordinator's thread.
    wait(lambda: sorted(titles()) == ["Footer coordinator", "Footer worker one", "Footer worker two"] and current() == "Footer worker one"
         and (listing() or {}).get("title") == "Threads · Footer coordinator", "coordinator's thread while its worker is focused")
    assert route() == one and "Threads · Footer worker one" not in screen(), route()
    shown("Threads · Footer coordinator", "Footer worker one Running", "Footer coordinator Main", "Footer worker two")
    assert "Local history" not in screen() and "Other thread worker" not in screen(), screen()
    save("list-worker-focused")
    passed("with a worker focused, the list shows its coordinator's thread: the main conversation and its workers, with the worker marked current")
    choose("Footer coordinator", "Open")
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
    wait(lambda: description("Footer worker one") == "Finished · FAIL" and description("Footer worker two") == "Finished · no report", "finished rows")
    assert titles()[0] == "Footer coordinator", rows()
    shown("Footer worker one Finished · FAIL")
    save("list-finished")
    passed("finished workers stay in the list as Finished with their verdict or native outcome")
    shown("Footer coordinator Main", "[Main] Footer coordinator")
    assert row("[Main] Footer coordinator") is None, rows()
    assert "[Main] Footer coordinator" in "\n".join(line[:42] for line in terminal.screen.display), screen()
    assert sandbox.api("GET", f"/api/session/{coordinator_id}")["data"]["title"] == "[Main] Footer coordinator"
    passed("the saved coordinator title and its native tab keep the [Main] prefix, while the list shows the title without it")
    choose("Footer worker one", "Dismiss")
    open_list()
    wait(lambda: description("Footer worker one") == "Closed · FAIL" and titles()[-1] == "Footer worker one", "dismissed from its menu")
    choose("Footer worker one", "Restore")
    open_list()
    wait(lambda: description("Footer worker one") == "Finished · FAIL", "restored from its menu")
    assert route() == coordinator_id, route()
    close_list()
    passed("a row's menu dismisses a worker to Closed and restores it without changing focus")

    provider.responses["FOOTER_THREE"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "Footer worker three passed", "evidence": ["fixture"]}}
    three = spawn(coordinator_id, "three", "Footer worker three", "FOOTER_THREE")
    eventually(lambda: worker_view(coordinator_id, three)["hidden"], timeout=60)
    idle(three)
    idle(coordinator_id)
    open_list()
    wait(lambda: row("Footer worker one") is not None and row("Footer worker three") is None, "hidden PASS worker left out of the list", 30)
    close_list()
    command("/threads")
    wait(lambda: description("Footer worker three") == "Finished · PASS", "/threads restores the hidden worker into the list")
    assert not worker_view(coordinator_id, three)["hidden"] and three not in native_tabs()
    shown("Footer worker three Finished · PASS")
    save("threads-restore")
    close_list()
    passed("/threads restores a hidden PASS worker into the list without opening its tab")
    open_list()
    choose("Footer worker two", "Dismiss")
    open_list()
    wait(lambda: description("Footer worker two") == "Closed · no report" and titles()[-1] == "Footer worker two", "worker two dismissed before the restart")
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
    os.write(terminal.master, b"\x18j")
    shown("Open a conversation to see its workers")
    assert listing() is None and "Threads ·" not in screen(), screen()
    save("list-home")
    assert state()["route"].get("type") == "home"
    passed("on the home screen ctrl+x j shows an open-a-conversation notice instead of listing other conversations or the running worker")
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
    wait(lambda: description("Footer worker two") == "Closed · no report" and titles()[-1] == "Footer worker two", "dismissed worker still closed after the restart")
    shown("Footer worker two Closed · no report")
    save("list-restart")
    close_list()
    command("/threads")
    wait(lambda: description("Footer worker two") == "Finished · no report", "/threads restores the dismissed worker")
    assert two not in native_tabs(), native_tabs()
    close_list()
    passed("a dismissed worker stays under Closed after a TUI restart until /threads restores it")
    open_list()
    choose("Footer worker four", "Open")
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
    choose("Footer coordinator", "Open")
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
    wait(lambda: description("Footer worker five") == "Running · running" and (listing() or {}).get("title") == "Threads · Footer coordinator", "thread list with the leftover options")
    assert titles().index("Footer worker five") < titles().index("Footer coordinator") and current() == "Footer coordinator", rows()
    assert not {"Local history", "Elsewhere history", "Other thread worker"} & set(titles()), rows()
    shown("Threads · Footer coordinator", "Footer worker five Running · running")
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
    choose("Footer worker one", "Open")
    wait(lambda: route() == one and one in native_tabs(), "reported worker tab opened from the list")
    provider.responses["FOOTER_HIDE_ONE"] = tool_call("threads_hide", {"workerID": one})
    sandbox.api("POST", f"/api/session/{coordinator_id}/prompt", {"text": "FOOTER_HIDE_ONE"})
    eventually(lambda: worker_view(coordinator_id, one)["hidden"], timeout=60)
    idle(coordinator_id)
    pause(4)
    assert route() == one and one in native_tabs(), (route(), native_tabs())
    open_list()
    choose("Footer coordinator", "Open")
    wait(lambda: route() == coordinator_id and one not in native_tabs(), "hidden worker tab closed after focus moved away", 30)
    passed("a hidden worker's tab stays open while it is focused and closes once focus moves away")
    open_list()
    wait(lambda: row("Footer worker two") is not None and row("Footer worker one") is None, "worker two listed before its deletion")
    search("Footer worker two")
    sandbox.api("DELETE", f"/api/session/{two}")
    pause(3)
    os.write(terminal.master, b"\r")
    wait(lambda: listing() is None, "stale list closed")
    pause(2)
    assert menu("Footer worker two") is None and "Threads:" not in screen(), screen()
    open_list()
    wait(lambda: row("Footer worker two") is None and row("Footer coordinator") is not None, "deleted worker left out of the list")
    close_list()
    passed("choosing a worker whose session was deleted while the list was open does nothing and shows no error; the next list leaves it out")
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
