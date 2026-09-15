import json
from pathlib import Path
import subprocess
import sys

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
    return json.loads((artifacts / "tabs.json").read_text())


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
    cli_path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, alpha["id"])
    expected_titles = ["Alpha coordinator", "Alpha worktree", "Beta coordinator", "Beta review"]
    expected_ids = [alpha["id"], alpha_worktree["id"], beta["id"], beta_review["id"]]
    terminal.wait_for_order(expected_titles)
    state = tab_state()
    assert [tab["sessionID"] for tab in state["tabs"]] == expected_ids, state
    assert state["route"] == {"type": "session", "sessionID": alpha["id"]}, state
    passed("interleaved native tabs become contiguous project groups without changing focus")
    passed("project groups and tabs within each group keep their original relative order")

    provider.responses["GROUP_WORKER"] = {
        "name": "threads_spawn",
        "arguments": {"key": "group-worker", "title": "Alpha new worker", "directory": str(worktree), "task": "Finish this local fixture turn."},
    }
    sandbox.api("POST", f'/api/session/{alpha["id"]}/prompt', {"text": "GROUP_WORKER"})
    terminal.wait_for_order(["Alpha coordinator", "Alpha worktree", "Alpha new worker", "Beta coordinator", "Beta review"])
    state = tab_state()
    assert [tab["title"] for tab in state["tabs"]] == ["Alpha coordinator", "Alpha worktree", "Alpha new worker", "Beta coordinator", "Beta review"], state
    assert state["route"]["sessionID"] == alpha["id"]
    grouped_ids = [tab["sessionID"] for tab in state["tabs"]]
    passed("a new managed worker joins its existing project group without taking focus")

    terminal.close(artifacts / "grouped.txt")
    terminal = None
    cli["plugins"][0]["options"]["openSessionIDs"] = []
    cli_path.write_text(json.dumps(cli))
    terminal = Terminal(sandbox, beta["id"])
    terminal.wait_for_order(["Alpha coordinator", "Alpha worktree", "Alpha new worker", "Beta coordinator", "Beta review"])
    eventually(lambda: tab_state()["route"].get("sessionID") == beta["id"])
    state = tab_state()
    assert state["route"]["sessionID"] == beta["id"], state
    assert [tab["sessionID"] for tab in state["tabs"]] == grouped_ids, state
    passed("project order survives reopening the TUI with another project selected")
finally:
    if terminal:
        terminal.close(artifacts / "reopened.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
