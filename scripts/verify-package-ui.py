import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def passed(label):
    checks.append(label)
    print("PASS: " + label, flush=True)


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
    terminal = Terminal(sandbox, session["id"])
    terminal.wait_for("ctrl+p commands")
    terminal.wait_for("Activity", left=True)
    passed("Activity loads without a probe plugin or project JSX configuration")
    os.write(terminal.master, b"/activities")
    terminal.wait_for("Choose Activity conversation")
    os.write(terminal.master, b"\r")
    terminal.wait_for("ctrl+f Pin · enter Open · esc Close")
    os.write(terminal.master, b"\x06")
    terminal.wait_for("ctrl+f Unpin · enter Open · esc Close")
    os.write(terminal.master, b"\x06")
    terminal.wait_for("ctrl+f Pin · enter Open · esc Close")
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda text: "enter Open · esc Close" not in text, "closed Activity picker", 10, False)
    passed("the Activity picker renders, toggles pin state, and closes with Escape")
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
    terminal.close(artifacts / "picker.txt")
    terminal = Terminal(sandbox, session["id"])
    terminal.wait_for("ctrl+p commands")
    terminal.wait_for("Activity", left=True)
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
