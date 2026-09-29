import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise SystemExit("Usage: verify-package-ui.py <published-package-or-npm-tarball>")
target = sys.argv[1]
install = None
plugin = target
if not target.startswith("@"):
    target = str(Path(target).resolve())
    if not Path(target).is_file() or not target.endswith(".tgz"):
        raise SystemExit("Pass an npm tarball, not an extracted directory: node_modules loading differs")
    tmp = subprocess.check_output([shutil.which("opencode"), "debug", "paths", "tmp"], text=True).strip()
    install = Path(tempfile.mkdtemp(prefix="threads-package-ui-", dir=tmp))
    (install / "package.json").write_text(json.dumps({
        "private": True,
        "dependencies": {"@op1/threads": "file:" + target},
    }))
    subprocess.run(["bun", "install", "--production", "--ignore-scripts"], cwd=install, check=True)
    plugin = str(install / "node_modules" / "@op1" / "threads")
artifacts = root / ".audit" / "package-ui"
provider = Provider()
sandbox = None
terminal = None
checks = []
indicator = re.compile(r"\d+ workers?\b|\d+ workflows?\b|needs input")


def passed(label):
    checks.append(label)
    print("PASS: " + label, flush=True)


def footer():
    return "\n".join(terminal.screen.display[-3:])


def left():
    return "\n".join(line[:42] for line in terminal.screen.display)


def screen():
    return "\n".join(terminal.screen.display)


hint = "ctrl+d Dismiss · enter Open · esc Close"
header = "Threads · Published plugin UI verification"
main_row = "> Published plugin UI verification"


def open_list(keys=b"\x18j"):
    os.write(terminal.master, keys)
    terminal.wait_for(hint)


def close_list():
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda text: "enter Open · esc Close" not in text, "closed Threads list", 10, False)


try:
    sandbox = Sandbox(config(plugin, provider), artifacts)
    sandbox.await_plugin()
    path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(path.read_text())
    cli.pop("plugins")
    path.write_text(json.dumps(cli))
    session = sandbox.api("POST", "/api/session", {
        "title": "Published plugin UI verification",
        "location": {"directory": str(sandbox.directory)},
    })["data"]
    # Earlier lists included every session in the TUI's folder; the thread list must not.
    sandbox.api("POST", "/api/session", {
        "title": "Unrelated package conversation",
        "location": {"directory": str(sandbox.directory)},
    })
    terminal = Terminal(sandbox, session["id"])
    terminal.wait_for("ctrl+p commands")
    terminal.wait_for("Published plugin UI verification", left=True)
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 3, "idle settle", 10, False)
    assert not indicator.search(footer()) and "Activity" not in left(), (footer(), left())
    passed("the default footer mode loads without a probe plugin or project JSX configuration and stays empty while idle")
    open_list()
    terminal.wait_for_match(lambda text: header in text and main_row in text, "the current conversation's thread", 10, False)
    assert "Unrelated package conversation" not in screen(), screen()
    assert not any(mark in screen() for mark in ("Pin ·", "Unpin", "◇", "◆")), screen()
    os.write(terminal.master, b"no-such-thread")
    terminal.wait_for_match(lambda text: "No matching conversations" in text and main_row not in text, "search without a match", 10, False)
    os.write(terminal.master, b"\x15")
    terminal.wait_for_match(lambda text: main_row in text and "No matching conversations" not in text, "search cleared", 10, False)
    (artifacts / "list.screen.txt").write_text(screen())
    close_list()
    passed("ctrl+x j opens the compiled Threads list with only the current conversation; its search reacts to typing and Escape closes it")
    os.write(terminal.master, b"/activities")
    terminal.wait_for("Show this conversation's workers")
    os.write(terminal.master, b"\r")
    terminal.wait_for(hint)
    terminal.wait_for(header)
    close_list()
    passed("/activities opens the same list")
    # FAIL keeps the finished worker in the list for the dismiss and focus checks.
    provider.responses["PACKAGE_WORKER_REPORT"] = {
        "name": "threads_report",
        "arguments": {"verdict": "FAIL", "summary": "Packaged worker", "evidence": ["installed package"]},
        "wait": True,
    }
    provider.responses["PACKAGE_WORKER_SPAWN"] = {
        "name": "threads_spawn",
        "arguments": {"key": "package-worker", "title": "Packaged footer worker", "directory": str(sandbox.worker), "task": "PACKAGE_WORKER_REPORT"},
    }
    sandbox.api("POST", f'/api/session/{session["id"]}/prompt', {"text": "PACKAGE_WORKER_SPAWN"})
    terminal.wait_for_match(lambda _: re.search(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 worker", footer()), "footer spinner and worker count", 40, False)
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 3, "worker tab settle", 10, False)
    assert "Packaged footer worker" not in left(), left()
    (artifacts / "running-footer.screen.txt").write_text("\n".join(terminal.screen.display))
    provider.release.set()
    eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"], timeout=60)
    terminal.wait_for_match(lambda _: not indicator.search(footer()), "footer cleared", 30, False)
    passed("a running worker shows the compiled footer spinner and count without opening a tab, and it clears when done")
    open_list()
    terminal.wait_for_match(lambda text: header in text and re.search(r"Packaged footer worker[ \t]+FAIL\b", text) and "Finished" in text, "finished worker in the thread list", 10, False)
    os.write(terminal.master, b"Packaged footer worker")
    terminal.wait_for("> Packaged footer worker")
    os.write(terminal.master, b"\x04")
    terminal.wait_for_match(lambda text: "ctrl+d Restore · enter Open · esc Close" in text and "· Closed" in text, "dismissed worker", 10, False)
    os.write(terminal.master, b"\x04")
    terminal.wait_for_match(lambda text: hint in text and "· Closed" not in text, "restored worker", 10, False)
    passed("ctrl+d dismisses and restores the highlighted worker without closing the compiled list")
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda _: "Packaged footer worker" in left() and "enter Open · esc Close" not in screen(), "focused worker tab", 20, False)
    open_list()
    terminal.wait_for_match(lambda text: header in text and "> Packaged footer worker" in text and "Published plugin UI verification" in text, "coordinator's thread from the worker", 10, False)
    assert "Threads · Packaged footer worker" not in screen(), screen()
    (artifacts / "worker-focused-list.screen.txt").write_text(screen())
    os.write(terminal.master, b"Published plugin")
    terminal.wait_for(main_row)
    os.write(terminal.master, b"\r")
    terminal.wait_for_match(lambda text: "enter Open · esc Close" not in text, "list closed after Enter", 10, False)
    # With an empty search, the list highlights the focused conversation.
    open_list()
    terminal.wait_for_match(lambda text: main_row in text and "> Packaged footer worker" not in text, "main conversation focused again", 10, False)
    close_list()
    passed("with the worker focused, the compiled list shows its coordinator's thread, and Enter returns to the main conversation")
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("No workflows yet")
    passed("the workflow navigator command is registered in the clean TUI")
    provider.responses["PACKAGE_WORKFLOW_SMOKE"] = {
        "name": "workflows_start",
        "arguments": {
            "key": "package-ui",
            "script": 'export const meta = { name: "package-ui", description: "Packaged workflow panel" }; await phase("Packaged phase"); return { verified: true };',
        },
    }
    sandbox.api("POST", f'/api/session/{session["id"]}/prompt', {"text": "PACKAGE_WORKFLOW_SMOKE"})
    def completed():
        runs = sandbox.api("POST", "/api/rpc/workflows/snapshot", {
            "input": {"ownerID": session["id"]},
        }, location=sandbox.directory)["output"]["runs"]
        return next((run for run in runs if run["status"] == "completed"), None)
    eventually(completed, timeout=60)
    eventually(lambda: session["id"] not in sandbox.api("GET", "/api/session/active")["data"])
    os.write(terminal.master, b"\x18n")
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 2, "home screen settle", 10, False)
    # The message renders only when the route has no conversation and the list has no rows.
    open_list()
    terminal.wait_for("Open a conversation to see its workers")
    assert "Threads ·" not in screen(), screen()
    (artifacts / "home-list.screen.txt").write_text(screen())
    close_list()
    passed("on the home screen the compiled list shows its open-a-conversation message")
    terminal.close(artifacts / "picker.txt")
    # Options left from earlier versions. Both are ignored; the checks below run with them.
    cli["plugins"] = [{"package": plugin, "options": {"activity": "sidebar", "workerTabs": "auto"}}]
    path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, session["id"])
    terminal.wait_for("ctrl+p commands")
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("Open dynamic workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("package-ui · completed")
    os.write(terminal.master, b"\r")
    terminal.wait_for("Phase: Packaged phase")
    terminal.wait_for('"verified": true')
    (artifacts / "workflow-panel.screen.txt").write_text("\n".join(terminal.screen.display))
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda text: "Phase: Packaged phase" not in text, "closed workflow panel", 10, False)
    passed("a real workflow completes and its compiled result panel opens and closes")
    provider.release.clear()
    provider.responses["PACKAGE_AUTO_REPORT"] = {
        "name": "threads_report",
        "arguments": {"verdict": "PASS", "summary": "Packaged automatic tab", "evidence": ["installed package"]},
        "wait": True,
    }
    provider.responses["PACKAGE_AUTO_SPAWN"] = {
        "name": "threads_spawn",
        "arguments": {"key": "package-auto", "title": "Packaged auto worker", "directory": str(sandbox.worker), "task": "PACKAGE_AUTO_REPORT"},
    }
    sandbox.api("POST", f'/api/session/{session["id"]}/prompt', {"text": "PACKAGE_AUTO_SPAWN"})
    terminal.wait_for_match(lambda _: re.search(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 worker", footer()), "footer indicator with the leftover options", 40, False)
    # Version 0.2.5 honored workerTabs: "auto" and would open this running worker's tab.
    settled = time.monotonic()
    terminal.wait_for_match(lambda _: time.monotonic() - settled >= 7, "two refresh intervals while the worker runs", 15, False)
    assert "Packaged auto worker" not in left() and "Activity" not in left() and "/activities" not in left(), left()
    assert len(indicator.findall(footer())) == 1, footer()
    open_list()
    terminal.wait_for_match(lambda text: header in text and re.search(r"Packaged auto worker[ \t]+running\b", text), "thread list with the leftover options", 10, False)
    (artifacts / "legacy-options.screen.txt").write_text(screen())
    close_list()
    provider.release.set()
    terminal.wait_for_match(lambda _: not indicator.search(footer()), "footer cleared after the worker", 60, False)
    passed('leftover activity: "sidebar" and workerTabs: "auto" options are ignored: no Activity rail appears, a running worker gets no tab, and the footer and Threads list still work')
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        log = sandbox.root / "data" / "opencode" / "log" / "opencode.log"
        if log.exists():
            lines = [line for line in log.read_text().splitlines() if "role=cli" in line and "plugin" in line.lower()]
            (artifacts / "plugin-loading.log").write_text("\n".join(lines) + "\n")
        sandbox.stop()
    provider.close()
    (artifacts / "evidence.json").write_text(json.dumps({"target": target, "plugin": plugin, "checks": checks}, indent=2) + "\n")
