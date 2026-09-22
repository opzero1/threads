import json
import fcntl
import os
import shutil
import struct
import termios
import time
from datetime import datetime, timedelta
from pathlib import Path

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually

root = Path(__file__).resolve().parent.parent
artifacts = root / ".audit" / "activity"
shutil.rmtree(artifacts, ignore_errors=True)
provider = Provider()
sandbox = None
terminal = None
checks = []

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

def texts(node):
    result = {node["id"]: node} if "fg" in node else {}
    for child in node.get("children", []):
        result.update(texts(child))
    return result

def foreground_contrast(snapshot, ids=("activity-new-session",)):
    def rail_parent(node):
        if any(child.get("id") == "op-threads-activity" for child in node["children"]):
            return node
        for child in node["children"]:
            parent = rail_parent(child)
            if parent:
                return parent
    def luminance(color):
        channels = [value / 255 for value in color[:3]]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
        return sum(value * weight for value, weight in zip(linear, [0.2126, 0.7152, 0.0722]))
    background = luminance(rail_parent(snapshot["tree"])["bg"])
    for id in ids:
        foreground = luminance(find(snapshot["tree"], id)["fg"])
        ratio = (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
        assert ratio >= 4.5, (snapshot["themeMode"], id, ratio)

def click(id, button=0):
    previous, since = None, time.monotonic()
    def settled(_):
        nonlocal previous, since
        node = rect(id)
        geometry = (node["x"], node["y"], node["width"], node["height"]) if node else None
        if geometry != previous:
            previous, since = geometry, time.monotonic()
        return node and node["width"] > 0 and 0 <= node["y"] < terminal.screen.lines and time.monotonic() - since >= 0.2
    terminal.wait_for_match(settled, "visible settled row geometry", 10, False)
    row = rect(id)
    x, y = row["x"] + min(2, row["width"] - 1) + 1, row["y"] + 1
    os.write(terminal.master, f"\x1b[<{button};{x};{y}M\x1b[<{button};{x};{y}m".encode())

def command(name):
    os.write(terminal.master, name.encode())
    terminal.wait_for_match(lambda _: any(name in line[(rect("session-pane") or {}).get("x", 42):] for line in terminal.screen.display[-10:]), f"{name} in the native prompt", 10, False)
    os.write(terminal.master, b"\r")

def passed(label):
    checks.append(label)
    print("PASS: " + label, flush=True)

def glyph(id):
    node = rect(id)
    if node and node["width"] > 0 and 0 <= node["y"] < terminal.screen.lines:
        return terminal.screen.display[node["y"]][node["x"]:node["x"] + node["width"]].strip()

def native_tabs():
    try:
        return json.loads((artifacts / "tabs.json").read_text())["tabs"]
    except (FileNotFoundError, json.JSONDecodeError):
        return []

try:
    sandbox = Sandbox(config(root, provider), artifacts)
    older_session = sandbox.api("POST", "/api/session", {"title": "[Main] Older history target", "location": {"directory": str(sandbox.worker)}})["data"]
    provider.responses["HISTORY_REPORT"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "History fixture complete", "evidence": ["saved managed relationship"]}}
    provider.responses["HISTORY_SPAWN"] = {"name": "threads_spawn", "arguments": {"key": "history-worker", "title": "Old hidden worker", "directory": str(sandbox.worker), "task": "HISTORY_REPORT"}}
    sandbox.api("POST", f'/api/session/{older_session["id"]}/prompt', {"text": "HISTORY_SPAWN"})
    eventually(lambda: any(worker.get("report") for worker in sandbox.api("POST", "/api/rpc/threads/snapshot", {"input": {"coordinatorIDs": [older_session["id"]]}}, location=sandbox.worker)["output"]["workers"]))
    eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"])
    for index in range(90):
        sandbox.api("POST", "/api/session", {"title": f"History fixture {index:03}", "location": {"directory": str(sandbox.worker)}})
    deep_directory = sandbox.root / "Users" / "fixture" / "workspaces" / "personal" / "op-threads"
    deep_directory.mkdir(parents=True)
    sessions = [sandbox.api("POST", "/api/session", {"title": title, "location": {"directory": str(directory)}})["data"] for title, directory in [
        ("First conversation", sandbox.directory), ("Second conversation", sandbox.worker), ("[Main] Ordinary title", deep_directory),
    ]]
    yesterday = sandbox.api("POST", "/api/session", {"title": "Yesterday conversation", "location": {"directory": str(sandbox.worker)}})["data"]
    exported = sandbox.api("GET", f'/api/experimental/session/{yesterday["id"]}/export')["data"]
    yesterday_time = int((datetime.now().replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=1)).timestamp() * 1000)
    exported["info"]["time"].update({"created": yesterday_time, "updated": yesterday_time, "idle": yesterday_time, "viewed": yesterday_time})
    sandbox.api("DELETE", f'/api/session/{yesterday["id"]}')
    yesterday = sandbox.api("POST", "/api/experimental/session/import", exported, location=sandbox.worker)["data"]
    path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(path.read_text())
    cli["theme"] = {"mode": "dark"}
    cli["plugins"][0]["options"].update({"openSessionIDs": [session["id"] for session in sessions[:2]], "tree": True, "mounts": True})
    path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, sessions[0]["id"])
    terminal.wait_for("ctrl+p commands")
    terminal.wait_for("Activity", left=True)
    terminal.wait_for("Today", left=True)
    terminal.wait_for("[Main] Ordinary title", left=True)
    terminal.wait_for("op-threads", left=True)
    assert " · Main" not in "\n".join(line[:42] for line in terminal.screen.display)
    passed("deep ordinary workspace subtitle shows its folder name without a managed role")
    terminal.wait_for_match(lambda _: rect("op-threads-activity") and rect("op-threads-activity")["width"] > 0, "Activity layout", 20, False)
    custom, pane = rect("op-threads-activity"), rect("session-pane")
    assert custom["x"] == 0 and custom["width"] == pane["x"], (custom, pane)
    assert pane["width"] + pane["x"] == 160, pane
    passed(f'Activity headings and cross-project history render without transcript overlap on OpenCode {sandbox.api("GET", "/api/info")["version"]}')
    click("activity-section-Today")
    terminal.wait_for("▸ Today", left=True)
    terminal.wait_for("Yesterday conversation", left=True)
    click("activity-section-Yesterday")
    terminal.wait_for("▸ Yesterday (1)", left=True)
    terminal.wait_for_match(lambda _: rect(f'activity-row-{yesterday["id"]}') is None, "Yesterday rows collapsed", 15, False)
    yesterday_heading = rect("activity-section-Yesterday")
    assert "───" in terminal.screen.display[yesterday_heading["y"]][yesterday_heading["x"]:yesterday_heading["x"] + yesterday_heading["width"]]
    assert state()["route"].get("sessionID") == sessions[0]["id"]
    assert sandbox.api("GET", f'/api/session/{yesterday["id"]}')["data"]["title"] == "Yesterday conversation"
    passed("clickable section headings collapse Yesterday with a count and a visible divider, preserving the open conversation")
    command("/activity-sections")
    terminal.wait_for("Activity sections")
    os.write(terminal.master, b"Today")
    terminal.wait_for("Expand Today")
    os.write(terminal.master, b"\r")
    terminal.wait_for("▾ Today", left=True)
    terminal.wait_for("First conversation", left=True)
    passed("keyboard section chooser expands Today without reopening the collapsed Yesterday section")
    terminal.wait_for_match(lambda _: rect(f'activity-title-{sessions[0]["id"]}') and rect(f'activity-title-{sessions[0]["id"]}')["width"] > 0, "expanded rows settle before theme snapshot", 10, False)
    before_theme = state()
    before_texts = texts(find(before_theme["tree"], "op-threads-activity"))
    assert before_texts
    assert len({tuple(node["fg"]) for node in before_texts.values()}) >= 3
    cli["theme"]["mode"] = "light"
    path.write_text(json.dumps(cli))
    def recolored(_):
        current = state()
        content = find(current["tree"], "op-threads-activity")
        if not content or current.get("themeText") == before_theme.get("themeText"):
            return False
        current_texts = texts(content)
        return all(id in current_texts and current_texts[id]["num"] == node["num"] and current_texts[id]["fg"] in [current["themeColors"][name] for name, color in before_theme["themeColors"].items() if color == node["fg"]] for id, node in before_texts.items())
    terminal.wait_for_match(recolored, "existing Activity text retains semantic color roles in light mode", 20, False)
    (artifacts / "theme-before.json").write_text(json.dumps(before_theme))
    (artifacts / "theme-after.json").write_text(json.dumps(state()))
    foreground_contrast(before_theme)
    foreground_contrast(state())
    passed("live theme change retains existing headers, rows and footers and updates their semantic text colors")
    pin_id = f'activity-pin-{sessions[1]["id"]}'
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"conversation")
    terminal.wait_for_match(lambda _: (rect(f'activity-picker-title-{sessions[0]["id"]}') or {}).get("text") == "> ◇ First conversation", "search highlights the first result", 10, False)
    os.write(terminal.master, b"\x1b[B")
    terminal.wait_for_match(lambda _: (rect(f'activity-picker-title-{sessions[1]["id"]}') or {}).get("text") == "> ◇ Second conversation", "Down highlights the next result", 10, False)
    os.write(terminal.master, b"\x1b[B")
    picker_title = f'activity-picker-title-{yesterday["id"]}'
    terminal.wait_for_match(lambda _: (rect(picker_title) or {}).get("text") == "> ◇ Yesterday conversation", "Down crosses the date heading", 10, False)
    os.write(terminal.master, b"\x06")
    terminal.wait_for_match(lambda _: (rect(picker_title) or {}).get("text") == "> ◆ Yesterday conversation" and "Unpin" in (rect("activity-picker-hint") or {}).get("text", ""), "Ctrl+F pins the highlighted conversation without closing the picker", 10, False)
    assert rect("activity-picker-search")["text"] == "conversation"
    assert state()["route"].get("sessionID") == sessions[0]["id"]
    os.write(terminal.master, b"\x06")
    terminal.wait_for_match(lambda _: (rect(picker_title) or {}).get("text") == "> ◇ Yesterday conversation" and "Unpin" not in (rect("activity-picker-hint") or {}).get("text", ""), "Ctrl+F unpins the same highlighted conversation", 10, False)
    assert rect("activity-picker-search")["text"] == "conversation"
    os.write(terminal.master, b"\x15no-such-activity-xyz")
    terminal.wait_for("No matching conversations")
    os.write(terminal.master, b"\x06\x1b")
    terminal.wait_for_match(lambda _: rect("activity-picker") is None, "Escape closes an empty picker safely", 10, False)
    passed("arrow keys cross Activity groups; Ctrl+F preserves the highlighted result and search through pin/unpin reordering and ignores empty results")
    terminal.wait_for_match(lambda _: glyph(pin_id) == "[◇]", "unpinned glyph", 10, False)
    click(pin_id)
    terminal.wait_for_match(lambda _: glyph(pin_id) == "[◆]" and rect(f'activity-row-{sessions[1]["id"]}')["y"] < rect("activity-section-Today")["y"], "one-click pin groups the background conversation", 10, False)
    foreground_contrast(state(), (pin_id,))
    assert state()["route"].get("sessionID") == sessions[0]["id"]
    click(pin_id)
    terminal.wait_for_match(lambda _: glyph(pin_id) == "[◇]" and rect("activity-section-Pinned") is None, "one-click unpin", 10, False)
    assert state()["route"].get("sessionID") == sessions[0]["id"]
    close_id = f'activity-close-{sessions[1]["id"]}'
    click(close_id)
    terminal.wait_for_match(lambda _: all(tab["sessionID"] != sessions[1]["id"] for tab in native_tabs()) and rect(f'activity-row-{sessions[1]["id"]}') is None, "one-click close removes native tab and Activity row", 10, False)
    assert state()["route"].get("sessionID") == sessions[0]["id"]
    assert sandbox.api("GET", f'/api/session/{sessions[1]["id"]}')["data"]["title"] == "Second conversation"
    passed("one-click pin/unpin and close glyphs act on background rows without changing focus or deleting history")
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"Second conversation")
    terminal.wait_for("Second conversation")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[1]["id"]}') is not None, "chooser restores dismissed row", 10, False)
    click(f'activity-row-{sessions[1]["id"]}')
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == sessions[1]["id"], "click switches native conversation", 10, False)
    passed("left-click focuses real session")
    command("/pin")
    terminal.wait_for("Pinned", left=True)
    passed("current-session pin command updates grouping")
    os.write(terminal.master, b"hello from Activity")
    terminal.wait_for("hello from Activity")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Fixture completed.")
    assert any("hello from Activity" in json.dumps(message) for message in sandbox.api("GET", f'/api/session/{sessions[1]["id"]}/message?type=user')["data"])
    passed("native prompt submits and renders model response")
    previous_width = rect("op-threads-activity")["width"]
    target_width = previous_width + 6
    os.write(terminal.master, f"\x1b[<0;{previous_width};15M\x1b[<32;{target_width};15M\x1b[<0;{target_width};15m".encode())
    terminal.wait_for_match(lambda _: rect("op-threads-activity") and rect("op-threads-activity")["width"] != previous_width and rect("op-threads-activity")["width"] == rect("session-pane")["x"], "native resize handle drag", 20, False)
    passed("native resize handle changes the rail width without overlapping the transcript")
    assert rect("activity-load-older") is None
    assert "Load older" not in "\n".join(line[:42] for line in terminal.screen.display)
    passed("Activity renders without a Load older control")
    terminal.wait_for_match(lambda _: (rect(f'activity-title-{older_session["id"]}') or {}).get("text") == "Older history target", "closed managed history title omits its role prefix", 15, False)
    assert sandbox.api("GET", f'/api/session/{older_session["id"]}')["data"]["title"] == "[Main] Older history target"
    assert all(tab["sessionID"] != older_session["id"] for tab in native_tabs())
    passed("known managed prefixes are removed in closed history without renaming saved titles")
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"Older history target")
    terminal.wait_for("Older history target")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == older_session["id"], "keyboard history navigation", 20, False)
    command("/pin")
    passed("keyboard selection opens a closed cross-project history session")
    provider.responses["ACTIVITY_BUSY"] = {"name": "threads_list", "arguments": {}, "wait": True}
    sandbox.api("POST", f'/api/session/{sessions[0]["id"]}/prompt', {"text": "ACTIVITY_BUSY"})
    terminal.wait_for("Priority", left=True)
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[0]["id"]}')["y"] < rect(f'activity-row-{sessions[1]["id"]}')["y"], "running outranks pin", 20, False)
    running_id = f'activity-running-{sessions[0]["id"]}'
    terminal.wait_for_match(lambda _: rect(running_id) and rect(running_id).get("nativeSpinner"), "OpenCode's registered spinner renders for busy session", 20, False)
    spinner_frames = set()
    def animated(_):
        node = rect(running_id)
        if node and node["width"] > 0:
            char = terminal.screen.display[node["y"]][node["x"]]
            if char in "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏":
                spinner_frames.add(char)
        return len(spinner_frames) >= 2
    terminal.wait_for_match(animated, "native running spinner advances rendered frames", 10, False)
    passed("running rows use OpenCode's registered spinner and visibly animate")
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"First conversation")
    priority_picker_title = f'activity-picker-title-{sessions[0]["id"]}'
    terminal.wait_for_match(lambda _: (rect(priority_picker_title) or {}).get("text") == "> ◇ First conversation", "highlight running Priority conversation", 10, False)
    os.write(terminal.master, b"\x06")
    terminal.wait_for_match(lambda _: (rect(priority_picker_title) or {}).get("text") == "> ◆ First conversation", "pin running Priority conversation in picker", 10, False)
    assert rect(f'activity-row-{sessions[0]["id"]}')["y"] < rect("activity-section-Pinned")["y"]
    assert rect(running_id) is not None
    assert state()["route"].get("sessionID") == older_session["id"]
    os.write(terminal.master, b"\x06")
    terminal.wait_for_match(lambda _: (rect(priority_picker_title) or {}).get("text") == "> ◇ First conversation", "unpin running Priority conversation in picker", 10, False)
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda _: rect("activity-picker") is None, "close Priority picker", 10, False)
    passed("picker pin shortcut works for Priority conversations without changing their running status or the open session")
    click("activity-section-Priority")
    terminal.wait_for("▸ Priority", left=True)
    terminal.wait_for_match(lambda _: rect(running_id) is None, "collapsed section releases spinner", 15, False)
    assert sessions[0]["id"] in sandbox.api("GET", "/api/session/active")["data"]
    click("activity-section-Priority")
    terminal.wait_for_match(lambda _: rect(running_id) and rect(running_id).get("nativeSpinner"), "expanded running section restores spinner", 15, False)
    passed("collapsing Priority releases its spinner while work continues; expanding restores it")
    sandbox.api("PATCH", f'/api/session/{sessions[1]["id"]}', {"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
    provider.responses["ACTIVITY_PERMISSION"] = {"name": "shell", "arguments": {"command": "true"}}
    sandbox.api("POST", f'/api/session/{sessions[1]["id"]}/prompt', {"text": "ACTIVITY_PERMISSION"})
    request = eventually(lambda: next(iter(sandbox.api("GET", f'/api/session/{sessions[1]["id"]}/permission')["data"]), None))
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[1]["id"]}').get("width", 0) > 0 and rect(f'activity-row-{sessions[1]["id"]}')["y"] < rect(f'activity-row-{sessions[0]["id"]}')["y"] and rect(f'activity-running-{sessions[1]["id"]}') is None, "permission outranks running and replaces its spinner", 20, False)
    passed("real permission attention precedes real running work, which precedes pinned idle history")
    sandbox.api("POST", f'/api/session/{sessions[1]["id"]}/permission/{request["id"]}/reply', {"decision": "once"})
    provider.release.set()
    eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"])
    terminal.wait_for_match(lambda _: rect(running_id) is None, "running spinner removed when session becomes idle", 20, False)
    passed("attention retains its marker and completed sessions release their running spinner")
    provider.release.clear()
    provider.responses["ACTIVITY_REPORT"] = {"name": "threads_report", "arguments": {"verdict": "PASS", "summary": "Activity fixture complete", "evidence": ["isolated native surface"]}, "wait": True}
    provider.responses["ACTIVITY_SPAWN"] = {"name": "threads_spawn", "arguments": {"key": "activity-worker", "title": "[Worker] Legacy worker", "directory": str(sandbox.worker), "task": "ACTIVITY_REPORT"}}
    sandbox.api("PATCH", f'/api/session/{sessions[0]["id"]}', {"title": "[Main] Legacy coordinator"})
    sandbox.api("POST", f'/api/session/{sessions[0]["id"]}/prompt', {"text": "ACTIVITY_SPAWN"})
    worker = eventually(lambda: next((session for session in sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"] if session.get("metadata", {}).get("opThreads", {}).get("key") == "activity-worker"), None))
    worker_id = worker["id"]
    terminal.wait_for("Legacy worker", left=True)
    eventually(lambda: sandbox.api("GET", f'/api/session/{worker_id}')["data"].get("title") == "Legacy worker")
    eventually(lambda: sandbox.api("GET", f'/api/session/{sessions[0]["id"]}')["data"].get("title") == "Legacy coordinator")
    provider.responses["ACTIVITY_SIBLING"] = {"name": "threads_spawn", "arguments": {"key": "activity-sibling", "title": "Sibling worker", "directory": str(sandbox.worker), "task": "Complete sibling fixture"}}
    eventually(lambda: sessions[0]["id"] not in sandbox.api("GET", "/api/session/active")["data"])
    sandbox.api("POST", f'/api/session/{sessions[0]["id"]}/prompt', {"text": "ACTIVITY_SIBLING"})
    sibling = eventually(lambda: next((session for session in sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"] if session.get("metadata", {}).get("opThreads", {}).get("key") == "activity-sibling"), None))
    sibling_id = sibling["id"]
    terminal.wait_for("Sibling worker", left=True)
    main_row = f'activity-row-{sessions[0]["id"]}'
    workers_heading = f'activity-workers-{sessions[0]["id"]}'
    worker_row = f'activity-row-{worker_id}'
    sibling_row = f'activity-row-{sibling_id}'
    terminal.wait_for_match(lambda _: rect(worker_row) and rect(sibling_row) and glyph(workers_heading) == "▾ Workers (2)" and rect(worker_row)["x"] == rect(sibling_row)["x"] == rect(main_row)["x"] + 3 and rect(main_row)["y"] < rect(workers_heading)["y"] < rect(worker_row)["y"] < rect(sibling_row)["y"] < rect("activity-section-Pinned")["y"], "main and two workers form one Priority stack with a Workers heading", 20, False)
    foreground_contrast(state(), (workers_heading,))
    assert rect(f'activity-running-{sessions[0]["id"]}') is None
    (artifacts / "stack-expanded.screen.txt").write_text("\n".join(terminal.screen.display))
    passed("an idle main and its two managed workers share one Priority stack beneath a counted Workers heading")
    click(workers_heading)
    terminal.wait_for_match(lambda _: glyph(workers_heading) == "▸ Workers (2)" and rect(worker_row) is None and rect(sibling_row) is None and rect(f'activity-running-{sessions[0]["id"]}') is not None, "Workers heading collapses stack and main summarizes running child", 15, False)
    assert state()["route"].get("sessionID") == older_session["id"]
    assert worker_id in sandbox.api("GET", "/api/session/active")["data"]
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"Legacy worker")
    terminal.wait_for("Legacy worker")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == worker_id and rect(worker_row) is None, "collapsed worker remains keyboard reachable", 15, False)
    click(f'activity-row-{older_session["id"]}')
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == older_session["id"], "return to background conversation", 15, False)
    eventually(lambda: sibling_id not in sandbox.api("GET", "/api/session/active")["data"])
    sandbox.api("PATCH", f'/api/session/{sibling_id}', {"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
    sandbox.api("POST", f'/api/session/{sibling_id}/prompt', {"text": "ACTIVITY_PERMISSION"})
    sibling_request = eventually(lambda: next(iter(sandbox.api("GET", f'/api/session/{sibling_id}/permission')["data"]), None))
    terminal.wait_for_match(lambda _: glyph(f'activity-marker-{sessions[0]["id"]}') == "?" and rect(f'activity-running-{sessions[0]["id"]}') is None and rect(sibling_row) is None, "collapsed stack surfaces worker input request above running status", 20, False)
    (artifacts / "stack-collapsed.screen.txt").write_text("\n".join(terminal.screen.display))
    command("/activity-threads")
    terminal.wait_for("Managed worker stacks")
    os.write(terminal.master, b"Legacy coordinator")
    terminal.wait_for("Expand Legacy coordinator")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: glyph(workers_heading) == "▾ Workers (2)" and rect(sibling_row) and rect(worker_row) and rect(main_row)["y"] < rect(sibling_row)["y"] < rect(worker_row)["y"], "keyboard expands stack with input-requesting worker first", 20, False)
    sandbox.api("POST", f'/api/session/{sibling_id}/permission/{sibling_request["id"]}/reply', {"decision": "once"})
    passed("stack collapse preserves running work, summarizes input requests, and supports keyboard navigation and expansion")
    provider.release.set()
    terminal.wait_for_match(lambda _: rect(f'activity-row-{worker_id}') is None, "PASS worker auto-hidden", 40, False)
    command("/threads")
    terminal.wait_for("Legacy worker", left=True)
    sandbox.api("PATCH", f'/api/session/{worker_id}', {"title": "[Worker] Intentional rename"})
    terminal.wait_for("Intentional rename", left=True)
    terminal.wait_for_match(lambda _: (rect(f'activity-title-{worker_id}') or {}).get("text") == "Intentional rename", "managed display omits a reapplied prefix", 10, False)
    click(f'activity-pin-{worker_id}')
    terminal.wait_for_match(lambda _: glyph(f'activity-pin-{worker_id}') == "[◆]", "pin worker directly within stack", 10, False)
    assert state()["route"].get("sessionID") == older_session["id"]
    click(f'activity-close-{worker_id}')
    terminal.wait_for_match(lambda _: rect(f'activity-row-{worker_id}') is None, "manually closed worker remains out of history", 20, False)
    assert state()["route"].get("sessionID") == older_session["id"]
    assert sandbox.api("GET", f'/api/session/{worker_id}')["data"]["title"] == "[Worker] Intentional rename"
    click(workers_heading)
    terminal.wait_for_match(lambda _: glyph(workers_heading) == "▸ Workers (1)" and rect(sibling_row) is None, "collapse remaining sibling for restart", 10, False)
    passed("legacy managed titles clean once; PASS hide, /threads restore and one-click worker pin/close preserve focus, history and renames")
    for width, height in [(130, 40), (75, 35), (160, 48)]:
        terminal.screen.resize(height, width)
        fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        terminal.wait_for_match(lambda _: state()["tree"].get("width") == width, "resize", 10, False)
        if width == 75:
            terminal.wait_for_match(lambda _: rect("op-threads-activity") is None, "narrow native fallback", 10, False)
        else:
            terminal.wait_for("Activity", left=True)
            terminal.wait_for_match(lambda _: rect("op-threads-activity") and rect("session-pane")["x"] == rect("op-threads-activity")["width"] > 0, "separate columns", 10, False)
    passed("wide/narrow/wide fallback and remount preserve layout")
    command("/activity")
    terminal.wait_for("+ New session", left=True)
    terminal.wait_for_match(lambda _: rect("op-threads-activity") is None, "native rail restored", 10, False)
    command("/activity")
    terminal.wait_for("Activity", left=True)
    passed("toggle restores native and remounts Activity")
    for toggle in range(1, 7):
        os.write(terminal.master, b"\x1b[17~")
        if toggle % 2:
            terminal.wait_for_match(lambda display: "Activity" not in display and rect("op-threads-activity") is None, "native sidebar after toggle", 15, True)
        else:
            terminal.wait_for("Activity", left=True)
    first_mount_frames = {}
    for line in (artifacts / "tabs.json.mount.jsonl").read_text().splitlines():
        frame = json.loads(line)
        if frame["toggle"] % 2 == 0:
            first_mount_frames.setdefault(frame["toggle"], frame["header"])
    assert first_mount_frames == {2: "Activity", 4: "Activity", 6: "Activity"}, first_mount_frames
    passed("mount swaps to Activity before the first paint without flashing native sidebar content")
    click("activity-new-session")
    terminal.wait_for_match(lambda _: state()["route"].get("type") == "home", "native new-session action", 20, False)
    terminal.wait_for("Activity", left=True)
    click(f'activity-row-{sessions[1]["id"]}')
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == sessions[1]["id"], "return from home", 20, False)
    passed("registered New session action opens native home; Activity returns to the real conversation")
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"[Main] Ordinary title")
    terminal.wait_for("[Main] Ordinary title")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: state()["route"].get("sessionID") == sessions[2]["id"], "open ordinary prefix fixture", 15, False)
    command("/pin")
    terminal.wait_for_match(lambda _: glyph(f'activity-pin-{sessions[2]["id"]}') == "[◆]", "pin selected dismissal fixture", 15, False)
    click(f'activity-close-{sessions[2]["id"]}')
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[2]["id"]}') is None and state()["route"].get("sessionID") != sessions[2]["id"], "closing selected pinned row hides it and navigates away", 15, False)
    terminal.close(artifacts / "first.txt")
    terminal = None
    (artifacts / "tabs.json.tree.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, sessions[0]["id"])
    terminal.wait_for("Activity", left=True)
    click(f'activity-row-{sessions[1]["id"]}')
    terminal.wait_for("Pinned", left=True)
    terminal.wait_for_match(lambda _: rect(f'activity-row-{older_session["id"]}') is not None, "pinned history conversation restored after restart", 20, False)
    assert sandbox.api("GET", f'/api/session/{sessions[2]["id"]}')["data"]["title"] == "[Main] Ordinary title"
    assert sandbox.api("GET", f'/api/session/{worker_id}')["data"]["title"] == "[Worker] Intentional rename"
    passed("pins persist after TUI restart; ordinary prefixed title is unchanged")
    assert rect(f'activity-row-{sessions[2]["id"]}') is None
    command("/activities")
    terminal.wait_for("Search")
    os.write(terminal.master, b"[Main] Ordinary title")
    terminal.wait_for("Closed")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[2]["id"]}') is not None and glyph(f'activity-pin-{sessions[2]["id"]}') == "[◆]", "chooser restores dismissed pinned row after restart", 15, False)
    click(f'activity-pin-{sessions[2]["id"]}')
    click(f'activity-row-{sessions[1]["id"]}')
    passed("closing a pinned conversation survives restart; /activities restores it with its saved title and pin")
    terminal.wait_for_match(lambda _: glyph(workers_heading) == "▸ Workers (1)" and rect(sibling_row) is None and rect(worker_row) is None, "worker stack remains collapsed and dismissed worker stays closed after restart", 15, False)
    assert any(tab["sessionID"] == sibling_id for tab in native_tabs())
    assert all(tab["sessionID"] != worker_id for tab in native_tabs())
    click(workers_heading)
    terminal.wait_for_match(lambda _: rect(sibling_row) and rect(sibling_row)["x"] == rect(main_row)["x"] + 3, "restored stack expands after restart", 15, False)
    passed("collapsed worker stacks survive TUI restart without closing their native tabs")
    command("/threads")
    terminal.wait_for("Intentional rename", left=True)
    terminal.wait_for_match(lambda _: glyph(workers_heading) == "▾ Workers (2)" and rect(worker_row) is not None, "/threads explicitly restores dismissed managed worker", 15, False)
    passed("dismissed managed workers stay closed across restarts until explicitly restored")
    terminal.wait_for_match(lambda _: rect("activity-section-Yesterday") and rect(f'activity-row-{yesterday["id"]}') is None, "Yesterday remains collapsed after restart", 20, False)
    command("/activity-sections")
    terminal.wait_for("Activity sections")
    os.write(terminal.master, b"Yesterday")
    terminal.wait_for("Expand Yesterday")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: rect(f'activity-row-{yesterday["id"]}') is not None, "Yesterday expands after restart", 15, False)
    passed("collapsed sections persist across TUI restart and can be expanded again")
    cli["plugins"].append({"package": str(root), "options": {"activity": False}})
    path.write_text(json.dumps(cli))
    terminal.wait_for_match(lambda _: rect("op-threads-activity") is None, "plugin reload restores native children", 30, False)
    terminal.wait_for("+ New session", left=True)
    cli["plugins"][-1]["options"]["activity"] = True
    path.write_text(json.dumps(cli))
    terminal.wait_for("Activity", left=True)
    terminal.wait_for("Pinned", left=True)
    passed("CLI plugin option reload detaches and remounts cleanly, retaining durable pins")
    terminal.close(artifacts / "reloaded.txt")
    terminal = None
    sandbox.api("DELETE", f'/api/session/{older_session["id"]}')
    (artifacts / "tabs.json.tree.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, sessions[1]["id"])
    terminal.wait_for("Pinned", left=True)
    terminal.wait_for("Today", left=True)
    assert rect(f'activity-row-{older_session["id"]}') is None
    assert "Activity:" not in "\n".join(terminal.screen.display)
    passed("deleted older pin resolves as missing without a stale row or error")
    sandbox.api("DELETE", f'/api/session/{sessions[1]["id"]}')
    terminal.wait_for_match(lambda _: rect(f'activity-row-{sessions[1]["id"]}') is None, "live deletion removes loaded pinned row", 10, False)
    recreated = sandbox.api("POST", "/api/session", {"id": sessions[1]["id"], "title": "Recreated unpinned conversation", "location": {"directory": str(sandbox.worker)}})["data"]
    assert recreated["id"] == sessions[1]["id"]
    terminal.wait_for("Recreated", left=True)
    click(f'activity-row-{recreated["id"]}', button=2)
    terminal.wait_for_match(lambda display: any(line.rstrip().endswith("  Pin") for line in display.splitlines()), "recreated session offers Pin, not Unpin", 10, False)
    assert "Unpin" not in "\n".join(terminal.screen.display)
    os.write(terminal.master, b"\x1b")
    passed("live deletion removes row and pin; session.created clears same-ID tombstone without restoring pin")
    cli["tabs"]["layout"] = "horizontal"
    path.write_text(json.dumps(cli))
    terminal.wait_for_match(lambda _: rect("op-threads-activity") is None, "horizontal native fallback", 30, False)
    passed("horizontal layout falls back to native tabs")
    fallback = [sandbox.api("POST", "/api/session", {"title": title, "location": {"directory": str(directory)}})["data"] for title, directory in [
        ("Fallback Alpha idle", sandbox.directory),
        ("Fallback Beta idle", sandbox.worker),
        ("Fallback Alpha running", sandbox.directory),
    ]]
    provider.release.clear()
    provider.responses["FALLBACK_BUSY"] = {"name": "threads_list", "arguments": {}, "wait": True}
    sandbox.api("POST", f'/api/session/{fallback[2]["id"]}/prompt', {"text": "FALLBACK_BUSY"})
    terminal.close(artifacts / "before-fallback.txt")
    terminal = None
    cli["plugins"][0]["options"]["openSessionIDs"] = [session["id"] for session in fallback]
    path.write_text(json.dumps(cli))
    (artifacts / "tabs.json").unlink(missing_ok=True)
    (artifacts / "tabs.json.tree.json").unlink(missing_ok=True)
    terminal = Terminal(sandbox, fallback[0]["id"])
    terminal.wait_for("ctrl+p commands")
    os.write(terminal.master, b"\x07")
    def fallback_grouped(_):
        try:
            native = json.loads((artifacts / "tabs.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return False
        tabs = native["tabs"]
        ids = [tab["sessionID"] for tab in tabs]
        if not all(session["id"] in ids for session in fallback):
            return False
        if any(not tab.get("projectID") for tab in tabs if tab["sessionID"] in {session["id"] for session in fallback}):
            return False
        projects = [f'project:{tab["projectID"]}' if tab.get("projectID") else f'session:{tab["sessionID"]}' for tab in tabs]
        groups = [project for index, project in enumerate(projects) if index == 0 or projects[index - 1] != project]
        return (rect("op-threads-activity") is None and len(groups) == len(set(projects))
            and any(tab["sessionID"] == fallback[2]["id"] and tab["busy"] for tab in tabs)
            and ids.index(fallback[2]["id"]) < ids.index(fallback[0]["id"])
            and native["route"].get("sessionID") == fallback[0]["id"])
    terminal.wait_for_match(fallback_grouped, "requested Activity preserves native grouping in loaded horizontal fallback", 30, False)
    (artifacts / "fallback-order.json").write_text((artifacts / "tabs.json").read_text())
    passed("Activity requested but unmounted preserves native project grouping and busy-before-idle ordering without changing focus")
    provider.release.set()
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
