import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlencode


root = Path(__file__).resolve().parent.parent
directory = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / "workflow-model"
artifacts.mkdir(parents=True, exist_ok=True)
binary = shutil.which("opencode2") or shutil.which("opencode")


def api(method, path, data=None):
    path += ("&" if "?" in path else "?") + urlencode({"location[directory]": str(directory)})
    command = [binary, "api", method, path]
    if data is not None:
        command.extend(["--data", json.dumps(data)])
    result = subprocess.run(command, cwd=directory, text=True, capture_output=True, check=True, timeout=60)
    return json.loads(result.stdout) if result.stdout.strip() else None


def rpc(method, data):
    return api("post", f"/api/rpc/workflows/{method}", {"input": data})["output"]


profile = api("get", "/api/agent/vera-core")["data"]
session = api("post", "/api/session", {
    "title": "Dynamic workflow real-model verification",
    "agent": "vera-core",
    "model": profile["model"],
    "location": {"directory": str(directory)},
    "permissions": [
        {"action": "shell", "resource": "*", "effect": "deny"},
        {"action": "edit", "resource": "*", "effect": "deny"},
        {"action": "subagent", "resource": "*", "effect": "deny"},
        {"action": "subagent", "resource": "vera-operator-readonly", "effect": "allow"},
        {"action": "subagent", "resource": "vera-engineer-readonly", "effect": "allow"},
    ],
})["data"]
owner = session["id"]
print(f"Real-model verification session: {owner}", flush=True)
api("post", f"/api/session/{owner}/prompt", {"text": """
Verify the installed dynamic workflow feature by authoring and running one SMALL read-only workflow.
Load workflow-authoring. Author the JavaScript yourself; do not use shell, edit, or ordinary subagent.
Start exactly one workflow with key real-model-smoke, concurrency 2 and maxAgents 2.
Two steps in parallel: vera-operator-readonly reads src/workflow-types.ts and returns the default concurrency and maxAgents limits;
vera-engineer-readonly reads src/workflow-rpc.ts and returns the three control action names.
Pass explicit absolute source paths in worker prompts. Use read access and JSON Schema for both outputs.
Return an object {limits: {concurrency: number, maxAgents: number}, controls: string[]} as the workflow result.
Keep worker prompts short; they only need one source read each and workflows_result. Use evidence paths.
After workflows_start returns, stop and wait for the automatic notification. Do not poll or start another run.
On notification, inspect that run once, summarize the real result, and stop. No files or external services need changing.
"""})

deadline = time.monotonic() + 600
run = None
while time.monotonic() < deadline:
    snapshot = rpc("snapshot", {"ownerID": owner})
    matching = [item for item in snapshot["runs"] if item["key"] == "real-model-smoke"]
    if matching:
        run = rpc("inspect", {"ownerID": owner, "runID": matching[0]["id"]})
        if run["status"] in ["completed", "failed", "stopped"]:
            break
    elif api("get", f"/api/session/{owner}")["data"].get("outcome") == "failed":
        break
    time.sleep(1)
if run is None or run["status"] != "completed":
    api("post", f"/api/session/{owner}/interrupt", {"resume": False})
    if run and run["status"] not in ["failed", "stopped"]:
        rpc("control", {"ownerID": owner, "runID": run["id"], "action": "stop"})
    (artifacts / "failure.json").write_text(json.dumps({"ownerID": owner, "run": run}, indent=2))
    raise AssertionError(f"Real-model run did not complete; inspect {owner} and {artifacts / 'failure.json'}")

assert run["result"]["limits"] == {"concurrency": 3, "maxAgents": 4}, run["result"]
assert sorted(run["result"]["controls"]) == ["pause", "resume", "stop"], run["result"]
assert len(run["steps"]) == 2 and all(step["status"] == "completed" for step in run["steps"])
assert all(step["report"]["verdict"] in ["PASS", "PASS WITH NOTES"] for step in run["steps"])
assert all(step["report"]["evidence"] for step in run["steps"])
assert all(step["model"]["providerID"] != "fixture" for step in run["steps"])
workers = []
for step in run["steps"]:
    worker = api("get", f'/api/session/{step["workerID"]}')["data"]
    configured = api("get", f'/api/agent/{step["input"]["agent"]}')["data"]["model"]
    assert step["model"] == worker["model"] == configured, step
    messages = api("get", f'/api/session/{step["workerID"]}/message?limit=30')["data"]
    reads = [part for message in messages if message["type"] == "assistant"
             for part in message["content"] if part["type"] == "tool" and part["name"] == "read"
             and part["state"]["status"] == "completed"]
    assert reads, f'Worker {step["workerID"]} did not perform a successful source read'
    workers.append({"id": worker["id"], "model": worker["model"], "reads": [part["state"]["input"] for part in reads]})
evidence = {"ownerID": owner, "run": run, "workers": workers}
(artifacts / "evidence.json").write_text(json.dumps(evidence, indent=2))
print(json.dumps({"status": run["status"], "runID": run["id"], "result": run["result"], "models": [step["model"] for step in run["steps"]], "evidence": str(artifacts / "evidence.json")}, indent=2))
