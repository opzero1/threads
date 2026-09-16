import json
from pathlib import Path
import sys
import threading
import time

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / ("idle-tabs" if target == root else "idle-tabs-package")
provider = Provider()
sandbox = None
terminals = []
readers = []
errors = []
stop = threading.Event()
checks = []


def drain(terminal):
    try:
        terminal.wait_for_match(lambda _: stop.is_set(), "parallel terminal observation", 90, False)
    except BaseException as error:
        errors.append(str(error))


def states():
    snapshots = []
    for path in artifacts.glob("tabs.json.*.json"):
        try:
            snapshots.append(json.loads(path.read_text()))
        except json.JSONDecodeError:
            pass
    return snapshots


def orders():
    return [[tab["sessionID"] for tab in state["tabs"]] for state in states()]


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


try:
    artifacts.mkdir(parents=True, exist_ok=True)
    for path in artifacts.glob("tabs.json.*"):
        path.unlink()
    sandbox = Sandbox(config(target, provider), artifacts)
    sessions = [sandbox.api("POST", "/api/session", {
        "title": title, "location": {"directory": str(sandbox.directory)},
    })["data"] for title in ["Idle investigation one", "Idle investigation two"]]
    for session in sessions:
        sandbox.api("POST", f"/api/session/{session['id']}/prompt", {"text": "Finish the investigation."})
        eventually(lambda: sandbox.api("GET", f"/api/session/{session['id']}")["data"].get("outcome") == "succeeded")
        assert not session.get("metadata", {}).get("opThreads"), session

    cli_path = sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"][0]["options"].update({
        "openSessionIDs": [session["id"] for session in sessions],
        "perProcess": True, "history": True,
    })
    cli_path.write_text(json.dumps(cli))
    for session in sessions:
        terminal = Terminal(sandbox, session["id"])
        terminals.append(terminal)
        reader = threading.Thread(target=drain, args=(terminal,))
        reader.start()
        readers.append(reader)

    session_ids = {session["id"] for session in sessions}

    def both_visible():
        snapshots = states()
        return len(snapshots) == 2 and {
            state["route"].get("sessionID") for state in snapshots
        } == session_ids and all(
            {tab["sessionID"] for tab in state["tabs"]} == session_ids
            and all(not tab["busy"] and not tab["attention"] for tab in state["tabs"])
            for state in snapshots
        )

    eventually(both_visible, timeout=40)
    passed("two native terminals show different selected sessions with both ordinary threads idle")
    time.sleep(2)
    initial = orders()
    start = time.monotonic()
    changes = []
    while time.monotonic() - start < 7:
        current = orders()
        if current != initial:
            changes.append({"seconds": round(time.monotonic() - start, 3), "orders": current})
            initial = current
        time.sleep(0.02)
    (artifacts / "order-changes.json").write_text(json.dumps(changes, indent=2) + "\n")
    assert not errors, errors
    assert not changes, f"Idle terminals kept rearranging shared tabs: {len(changes)} changes; see {artifacts / 'order-changes.json'}"
    assert both_visible(), states()
    assert len({tuple(order) for order in orders()}) == 1, orders()
    passed("idle tab order remains identical and stable across terminals and periodic refreshes")
finally:
    stop.set()
    for reader in readers:
        reader.join(timeout=5)
    for index, terminal in enumerate(terminals):
        terminal.close(artifacts / f"terminal-{index}.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
