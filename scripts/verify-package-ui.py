import json
import os
import sys
from pathlib import Path

from fixture import Provider, config
from sandbox import Sandbox, Terminal


root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise SystemExit("Usage: verify-package-ui.py <published-package-or-extracted-directory>")
target = sys.argv[1]
if not target.startswith("@"):
    target = str(Path(target).resolve())
    if Path(target).is_relative_to(root):
        raise SystemExit("Extract and install the package outside the source checkout")
artifacts = root / ".audit" / "package-ui"
provider = Provider()
sandbox = None
terminal = None
checks = []


def passed(label):
    checks.append(label)
    print("PASS: " + label, flush=True)


try:
    sandbox = Sandbox(config(target, provider), artifacts)
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
    terminal.wait_for("/activities")
    os.write(terminal.master, b"\r")
    terminal.wait_for("enter Open · esc Close")
    passed("the Activity picker renders through the published TSX entrypoint")
    os.write(terminal.master, b"\x1b")
    terminal.wait_for_match(lambda text: "enter Open · esc Close" not in text, "closed Activity picker", 10, False)
    os.write(terminal.master, b"/workflows")
    terminal.wait_for("/workflows")
    os.write(terminal.master, b"\r")
    terminal.wait_for("No workflows yet")
    passed("the workflow navigator command is registered in the clean TUI")
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
    (artifacts / "evidence.json").write_text(json.dumps({"target": target, "checks": checks}, indent=2) + "\n")
