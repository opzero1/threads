import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from fixture import Provider, code_mode_namespace, code_mode_result, config, exposed, tool_call
from sandbox import Sandbox, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = Path(os.environ["THREADS_ARTIFACT_DIR"]).resolve() if "THREADS_ARTIFACT_DIR" in os.environ else root / ".audit" / "workflow-cleanup" / uuid.uuid4().hex
artifacts.mkdir(parents=True, exist_ok=False)
provider = Provider()
sandbox = None
checks = []
identity = "-c user.name=Workflow -c user.email=workflow@example.test"


def source_hash():
    digest = hashlib.sha256()
    for path in [target / "index.ts", target / "package.json", *sorted((target / "src").glob("*.ts"))]:
        digest.update(str(path.relative_to(target)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


verified_source = source_hash()


class WorkflowSandbox(Sandbox):
    def start(self):
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "README.md").write_text("Worktree cleanup fixture\n")
            subprocess.run(["git", "add", "README.md"], cwd=self.directory, check=True)
            subprocess.run(["git", "-c", "user.name=Workflow fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"], cwd=self.directory, check=True, capture_output=True)
        super().start()


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def messages(session_id):
    return sandbox.api("GET", f"/api/session/{session_id}/message?limit=100")["data"]


def run_tool(session_id, name, arguments):
    def results():
        return [
            part for message in messages(session_id) if message["type"] == "assistant"
            for part in message["content"] if part["type"] == "tool" and part["name"] == exposed(name)
            and part["state"]["status"] in ["completed", "error"]
        ]

    before = {part["id"] for part in results()}
    marker = f"FIXTURE_{uuid.uuid4().hex}"
    provider.responses[marker] = tool_call(name, arguments)
    sandbox.api("POST", f"/api/session/{session_id}/prompt", {"text": marker})
    output = eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60)
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"])
    return code_mode_result(name, output)


def decoded(part):
    assert part["state"]["status"] == "completed", part
    return json.loads(part["state"]["content"][0]["text"])


def inspect(owner, run_id):
    return sandbox.api("POST", "/api/rpc/workflows/inspect", {"input": {"ownerID": owner, "runID": run_id}}, location=sandbox.directory)["output"]


def writer(marker, command=None):
    # Lowercase, so the owner's completion notice doesn't contain the marker the provider matches.
    result = {"name": "workflows_result", "arguments": {"verdict": "PASS", "summary": marker.lower(), "evidence": [marker.lower()], "result": marker.lower()}}
    provider.responses[marker] = {"sequence": ([{"name": "shell", "arguments": {"command": command}}] if command else []) + [result]}


def step(key, prompt):
    return f'await agent("{prompt}", {{ key: "{key}", agent: "fixture-writer", access: "write", isolation: "worktree" }});'


def script(name, body):
    return f'export const meta = {{ name: "{name}", description: "Worktree cleanup verification" }};\n{body}'


def worktrees():
    return subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=sandbox.directory, check=True, capture_output=True, text=True).stdout


def outcomes(run):
    return {entry["key"]: entry["outcome"] + (":" + entry["reason"] if "reason" in entry else "") for entry in run["worktreeCleanup"]["worktrees"]}


def directory(run, key):
    return Path(next(item["directory"] for item in run["steps"] if item["key"] == key))


try:
    settings = config(target, provider)
    settings["agents"] = {
        "fixture-writer": {"mode": "subagent", "steps": 8, "permissions": [{"action": "*", "resource": "*", "effect": "allow"}]},
        "fixture-no-edit": {"mode": "primary", "steps": 8, "permissions": [
            {"action": "*", "resource": "*", "effect": "allow"},
            {"action": "edit", "resource": "*", "effect": "deny"},
        ]},
    }
    sandbox = WorkflowSandbox(settings, artifacts)
    sandbox.await_plugin()
    owner = sandbox.api("POST", "/api/session", {"title": "Worktree cleanup", "location": {"directory": str(sandbox.directory)}})["data"]["id"]

    writer("WORKFLOW_CLEAN")
    writer("WORKFLOW_BRANCH", f"git switch -q -c workflow/kept && git {identity} commit -q --allow-empty -m kept")
    writer("WORKFLOW_DETACHED", f"git {identity} commit -q --allow-empty -m detached")
    writer("WORKFLOW_DIRTY", "printf 'kept\\n' > proof.txt")
    writer("WORKFLOW_SHARED")
    started = decoded(run_tool(owner, "workflows_start", {"key": "mixed", "script": script("mixed", "\n".join([
        step("clean", "WORKFLOW_CLEAN"), step("branch", "WORKFLOW_BRANCH"), step("detached", "WORKFLOW_DETACHED"), step("dirty", "WORKFLOW_DIRTY"),
        'await agent("WORKFLOW_SHARED", { key: "shared", agent: "fixture-writer", access: "write" });',
        'return "done";',
    ]))}))
    run = eventually(lambda: (lambda value: value if value.get("worktreeCleanup", {}).get("complete") else None)(inspect(owner, started["id"])), timeout=90)
    (artifacts / "mixed-run.json").write_text(json.dumps(run, indent=2))
    assert run["status"] == "completed" and run["result"] == "done" and "error" not in run, run
    assert run["delivered"] and isinstance(run.get("finished"), (int, float)), run
    assert outcomes(run) == {"clean": "removed", "branch": "removed", "detached": "kept:commits", "dirty": "kept:changes"}, run
    listed = worktrees()
    for key in ["clean", "branch"]:
        assert not directory(run, key).exists() and str(directory(run, key)) not in listed, (key, listed)
    for key in ["detached", "dirty"]:
        assert directory(run, key).is_dir() and str(directory(run, key)) in listed, (key, listed)
    assert (directory(run, "dirty") / "proof.txt").read_text() == "kept\n"
    branch = subprocess.run(["git", "branch", "--list", "workflow/kept"], cwd=sandbox.directory, check=True, capture_output=True, text=True).stdout
    assert "workflow/kept" in branch, branch
    assert directory(run, "shared").resolve() == sandbox.directory.resolve() and (sandbox.directory / "README.md").exists()
    passed("a completed run removes clean and branch-backed worktrees through OpenCode and keeps changed or detached work")

    writer("WORKFLOW_WAITING")
    waiting_start = decoded(run_tool(owner, "workflows_start", {"key": "waiting", "script": script("waiting",
        step("write", "WORKFLOW_WAITING") + '\nreturn await checkpoint("Continue?", { key: "continue", reviewer: "coordinator" });')}))
    waiting = eventually(lambda: (lambda value: value if value["status"] == "waiting" else None)(inspect(owner, waiting_start["id"])), timeout=60)
    waiting_directory = directory(waiting, "write")
    dry = decoded(run_tool(owner, "workflows_prune", {}))
    (artifacts / "prune-dry.json").write_text(json.dumps(dry, indent=2))
    assert dry["applied"] is False, dry
    by_key = {(entry["runID"], entry["key"]): entry for entry in dry["worktrees"]}
    assert by_key[(waiting_start["id"], "write")]["outcome"] == "kept" and by_key[(waiting_start["id"], "write")]["reason"] == "unfinished", dry
    assert by_key[(started["id"], "dirty")]["reason"] == "changes" and by_key[(started["id"], "detached")]["reason"] == "commits", dry
    assert dry["counts"]["wouldRemove"] == 0 and waiting_directory.is_dir(), dry
    passed("a dry-run prune lists kept worktrees with reasons, including a waiting run's, and changes nothing")

    (directory(run, "dirty") / "proof.txt").unlink()
    preview = decoded(run_tool(owner, "workflows_prune", {}))
    assert [(entry["key"], entry["outcome"]) for entry in preview["worktrees"] if entry["outcome"] == "would-remove"] == [("dirty", "would-remove")], preview
    assert directory(run, "dirty").is_dir()

    dirty_worker = next(item["workerID"] for item in run["steps"] if item["key"] == "dirty")
    provider.release.clear()
    provider.responses["WORKFLOW_BUSY"] = {"sequence": [{"name": "shell", "wait": True, "arguments": {"command": "true"}}]}
    decoded(run_tool(owner, "threads_send", {"workerID": dirty_worker, "key": "busy", "text": "WORKFLOW_BUSY. Run the command."}))
    eventually(lambda: dirty_worker in sandbox.api("GET", "/api/session/active")["data"])
    held = decoded(run_tool(owner, "workflows_prune", {"apply": True}))
    (artifacts / "prune-busy.json").write_text(json.dumps(held, indent=2))
    busy = next(entry for entry in held["worktrees"] if entry["key"] == "dirty")
    assert busy["outcome"] == "kept" and busy["reason"] == "in-use" and "running" in busy["message"], held
    assert held["counts"]["removed"] == 0 and directory(run, "dirty").is_dir(), held
    provider.release.set()
    eventually(lambda: dirty_worker not in sandbox.api("GET", "/api/session/active")["data"], timeout=60)
    passed("prune keeps a finished run's clean worktree while its worker runs a follow-up")

    applied = decoded(run_tool(owner, "workflows_prune", {"apply": True}))
    (artifacts / "prune-apply.json").write_text(json.dumps(applied, indent=2))
    assert applied["counts"]["removed"] == 1 and [entry["key"] for entry in applied["worktrees"] if entry["outcome"] == "removed"] == ["dirty"], applied
    assert not directory(run, "dirty").exists() and str(directory(run, "dirty")) not in worktrees()
    assert directory(run, "detached").is_dir() and waiting_directory.is_dir()
    recorded = inspect(owner, started["id"])
    assert outcomes(recorded)["dirty"] == "removed" and recorded["status"] == "completed" and recorded["result"] == "done", recorded
    for item in recorded["steps"]:
        assert sandbox.api("GET", f'/api/session/{item["workerID"]}')["data"]["id"] == item["workerID"]
    passed("prune with apply removes a worktree once it is clean and keeps run records and worker sessions")

    restricted = sandbox.api("POST", "/api/session", {"agent": "fixture-no-edit", "location": {"directory": str(sandbox.directory)}})["data"]["id"]
    earlier = len(provider.requests)
    denied = run_tool(restricted, "workflows_prune", {"apply": True})
    assert denied["state"]["status"] == "error", denied
    assert directory(run, "detached").is_dir()
    # prune and save use the edit permission, so the restricted catalog lists 9 of the 11 workflows tools.
    assert any(code_mode_namespace(request, "workflows", 9) for request in provider.requests[earlier:]), "restricted Code Mode catalog"
    assert any(code_mode_namespace(request, "workflows", 11) for request in provider.requests[:earlier]), "owner Code Mode catalog"
    passed("an agent that cannot edit cannot prune, and its Code Mode catalog omits the edit-gated workflow tools")

    decoded(run_tool(owner, "workflows_control", {"runID": waiting_start["id"], "action": "stop"}))
    stopped = eventually(lambda: (lambda value: value if value.get("worktreeCleanup", {}).get("complete") else None)(inspect(owner, waiting_start["id"])), timeout=60)
    assert stopped["status"] == "stopped" and outcomes(stopped) == {"write": "removed"}, stopped
    assert not waiting_directory.exists() and str(waiting_directory) not in worktrees()
    passed("stopping a waiting run ends it and removes its clean worktree")

    assert source_hash() == verified_source, "Implementation changed during verification; rerun against the final source"
    (artifacts / "evidence.json").write_text(json.dumps({"checks": checks, "providerRequests": len(provider.requests), "sourceHash": verified_source, "target": str(target)}, indent=2))
finally:
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2))
    if sandbox:
        sandbox.stop()
    provider.close()

print(json.dumps({"checks": checks, "artifacts": str(artifacts)}, indent=2))
