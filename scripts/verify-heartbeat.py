"""Isolated loopback heartbeat lifecycle; never uses the shared service or global config."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import sandbox as sandbox_module
from sandbox import Sandbox, eventually
from fixture import Provider, code_mode_result, config, exposed, tool_call

root = Path(__file__).resolve().parent.parent
runner = Path(os.environ.get("HEARTBEAT_TEST_BIN", str(root / "bin/op-threads-heartbeat.mjs"))).resolve()
artifacts = Path(os.environ.get("HEARTBEAT_TEST_ARTIFACTS", str(root / ".audit/recovery/heartbeat/native"))).resolve()
artifacts.mkdir(parents=True, exist_ok=True)
checks = []
commands = []
provider = Provider()
sandbox = None
installed = False
label = "com.opthreads.heartbeat.test-" + uuid.uuid4().hex
config_file = None

class IsolatedSandbox(Sandbox):
    def api(self, method, path, body=None, location=None):
        try:
            return super().api(method, path, body, location)
        except RuntimeError as error:
            if path == "/api/info" and ": 503 " in str(error):
                return {}
            raise

    def start(self):
        self.env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "fixture.txt").write_text("heartbeat fixture\n")
            subprocess.run(["git", "add", "."], cwd=self.directory, check=True, capture_output=True)
            subprocess.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], cwd=self.directory, check=True, capture_output=True)
        super().start()

def check(label, value=True):
    assert value, label
    checks.append(label)
    print("PASS:", label, flush=True)

def cli(*args, success=True):
    command = ["node", str(runner), *args, "--config", str(config_file)]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=90)
    commands.append({"command": command, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
    (artifacts / "commands.json").write_text(json.dumps(commands, indent=2))
    if success:
        assert result.returncode == 0, commands[-1]
        return json.loads(result.stdout)
    assert result.returncode != 0, commands[-1]
    return result

def tool(session, name, arguments):
    def results():
        messages = sandbox.api("GET", f"/api/session/{session}/message?limit=100")["data"]
        return [part for message in messages if message["type"] == "assistant" for part in message["content"]
                if part["type"] == "tool" and part["name"] == exposed(name) and part["state"]["status"] in ["completed", "error"]]
    before = {part["id"] for part in results()}
    marker = "HEARTBEAT_" + uuid.uuid4().hex
    provider.responses[marker] = tool_call(name, arguments)
    sandbox.api("POST", f"/api/session/{session}/prompt", {"text": marker})
    result = code_mode_result(name, eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60))
    eventually(lambda: session not in sandbox.api("GET", "/api/session/active")["data"])
    assert result["state"]["status"] == "completed", result
    return json.loads(result["state"]["content"][0]["text"])

try:
    # Keep the existing deterministic fixture, but constrain every filesystem write to this worktree.
    original_mkdtemp = sandbox_module.tempfile.mkdtemp
    sandbox_module.tempfile.mkdtemp = lambda prefix, dir: original_mkdtemp(prefix=prefix, dir=artifacts)
    try:
        sandbox = IsolatedSandbox(config(root, provider), artifacts)
    finally:
        sandbox_module.tempfile.mkdtemp = original_mkdtemp
    sandbox.await_plugin()
    owner = sandbox.api("POST", "/api/session", {"permissions": [{"action": "heartbeat-fixture", "resource": "*", "effect": "ask"}]}, location=sandbox.directory)["data"]["id"]
    run = tool(owner, "workflows_start", {"key": "heartbeat-native", "script": 'export const meta = { name: "heartbeat", description: "fixture" }; return await checkpoint("Inspect", { key: "arbitrary", reviewer: "coordinator" });'})
    enrolled = tool(owner, "workflows_heartbeat_enroll", {"key": "native", "runID": run["id"], "deadlineAt": int(time.time() * 1000) + 600_000,
        "policy": {"cooldownMs": 1_000, "idleGraceMs": 1_000, "stalledMs": 1_000, "maxAckRetries": 1}})
    check("enrollment makes no immediate wake", enrolled["wakesReserved"] == 0)
    patched = tool(owner, "workflows_heartbeat_update", {"key": "native", "expectedRevision": enrolled["revision"], "change": {"type": "policy", "patch": {"maxWakes": 2}}})
    check("native registered maxWakes-only patch preserves custom intervals and maxAckRetries1", patched["policy"] == {**enrolled["policy"], "maxWakes": 2})
    enrolled = patched
    host = sandbox.root / "host"
    host.mkdir()
    config_file = sandbox.root / "runner.json"
    config_data = {"protocol": 1, "serviceFile": str(sandbox.root / "state/opencode/service.json"), "hostDirectory": str(host),
                   "node": subprocess.check_output(["which", "node"], text=True).strip(), "runner": str(runner),
                   "intervalMs": 60_000, "label": label, "launchAgentsDirectory": str(sandbox.root / "launchagents")}
    config_file.write_text(json.dumps(config_data))
    snapshot = sandbox.api("POST", "/api/rpc/workflows-heartbeat/snapshot", {"input": {"limit": 100}}, location=host)["output"]
    check("cold host RPC activates plugin and reads coordinator checkpoint", snapshot["entries"][0]["run"]["checkpoints"][0]["reviewer"] == "coordinator")
    schema = sandbox.api("GET", "/openapi.json")
    (artifacts / "openapi.json").write_text(json.dumps(schema, indent=2))
    shadow = cli("once", "--shadow")
    check("actual Node shadow returns complete observation", shadow["decisions"][0]["observation"]["kind"] == "complete")
    after_shadow = sandbox.api("POST", "/api/rpc/workflows-heartbeat/snapshot", {"input": {}}, location=host)["output"]
    check("shadow is storage read-only", after_shadow == snapshot)
    time.sleep(1.1)

    def native_hold(field):
        observed = cli("once", "--shadow")["decisions"][0]
        (artifacts / (field + "-observation.json")).write_text(json.dumps(observed, indent=2))
        check("native " + field + " observed by actual heartbeat path", observed["observation"]["kind"] == "complete" and
              any(item["id"] == owner and item[field] for item in observed["observation"]["sessions"]))
        check("native " + field + " shadow holds", observed["decision"]["kind"] == "hold" and observed["decision"]["reason"] == "input, permission, form, revert or interruption hold")
        applied_hold = cli("once")["decisions"][0]
        check("native " + field + " apply holds without reserving or admitting", applied_hold["decision"]["kind"] == "hold" and applied_hold["wakesReserved"] == 0 and applied_hold["pendingAdmission"] is None and applied_hold["admissions"] == [])

    queued = sandbox.api("POST", f"/api/session/{owner}/prompt", {"text": "parked task-owned hold fixture", "delivery": "queue", "resume": False})["data"]["id"]
    native_hold("queued")
    sandbox.api("DELETE", f"/api/session/{owner}/inbox/{queued}")
    form = sandbox.api("POST", f"/api/session/{owner}/form", {"title": "Task-owned heartbeat hold", "fields": [{"key": "fixture", "type": "string", "required": True}]})["data"]["id"]
    native_hold("form")
    sandbox.api("DELETE", f"/api/session/{owner}/form/{form}")
    permission_result = sandbox.api("POST", f"/api/session/{owner}/permission", {"action": "heartbeat-fixture", "resources": ["task-owned"]})["data"]
    (artifacts / "permission-create.json").write_text(json.dumps(permission_result, indent=2))
    try:
        permission = eventually(lambda: next((request for request in sandbox.api("GET", f"/api/session/{owner}/permission")["data"] if request["id"] == permission_result["id"]), None))
        check("task-owned permission creation returned ask and exact pending ID", permission_result["effect"] == "ask" and permission["action"] == "heartbeat-fixture")
        native_hold("permission")
    finally:
        sandbox.api("POST", f"/api/session/{owner}/permission/{permission_result['id']}/reply", {"decision": "reject"})
    check("task-owned permission rejection removes exact pending request without approval", all(request["id"] != permission_result["id"] for request in sandbox.api("GET", f"/api/session/{owner}/permission")["data"]))
    applied = cli("once")
    wake = applied["decisions"][0]
    check("ticker admits one queued owner inspection reminder", wake["wakesReserved"] == 1 and wake["admissions"][0]["state"] == "acknowledged")
    admission_id = wake["admissions"][0]["messageID"]
    def exact_admission():
        inbox = sandbox.api("GET", f"/api/session/{owner}/inbox")["data"]
        pending = next((item for item in inbox if item["id"] == admission_id), None)
        if pending:
            return pending["type"] == "synthetic" and pending["delivery"] == "queue" and pending["payload"]["metadata"]["heartbeatMonitorID"] == enrolled["monitorID"]
        try:
            exact = sandbox.api("GET", f"/api/session/{owner}/message/{admission_id}")["data"]
            return exact["type"] == "synthetic" and exact["metadata"]["heartbeatMonitorID"] == enrolled["monitorID"]
        except RuntimeError:
            return False
    check("exact native admission identity present in inbox or promoted message", eventually(exact_admission))
    def promoted():
        try:
            return sandbox.api("GET", f"/api/session/{owner}/message/{admission_id}")["data"]
        except RuntimeError:
            return False
    check("idle owner wakes and promotes the exact reminder without another owner prompt", eventually(promoted)["type"] == "synthetic")
    eventually(lambda: owner not in sandbox.api("GET", "/api/session/active")["data"])
    sandbox.api("DELETE", "/api/debug/location", location=host)
    shadow2 = cli("once", "--shadow")
    check("evicted heartbeat host reload conserves budget and deadline", shadow2["decisions"][0]["wakesReserved"] == 1 and shadow2["decisions"][0]["deadlineAt"] == enrolled["deadlineAt"])
    stopped = tool(owner, "workflows_heartbeat_stop", {"key": "native", "expectedRevision": wake["revision"], "reason": "isolated fixture ends; not acceptance"})
    check("explicit stop is monitor-only", stopped["mode"] == "stopped")
    sandbox.stop()
    down = cli("once", "--shadow", success=False)
    check("service-down Node CLI remains connect-only", "connect-only" in down.stderr and sandbox.process.poll() is not None)
    sandbox.start()
    restarted = cli("once", "--shadow")
    check("isolated server restart conserves stop/deadline/spent budget", restarted["decisions"][0]["mode"] == "stopped" and restarted["decisions"][0]["wakesReserved"] == 1)
    # Install only a unique task-owned LaunchAgent with paths under the receipt directory.
    config_file.unlink()
    install = cli("install", "--service-file", config_data["serviceFile"], "--host-directory", str(host), "--label", label, "--launchagents-directory", config_data["launchAgentsDirectory"])
    installed = True
    check("isolated LaunchAgent installer reads back task-owned label", label in install["readback"]["stdout"])
    status = cli("status")
    check("actual status observes existing service and launcher", status["launcher"]["code"] == 0 and status["observation"]["available"])
    removed = cli("uninstall")
    installed = False
    check("uninstall removes only task-owned launcher with negative readback", removed["readback"]["code"] != 0 and not config_file.exists())
finally:
    if installed:
        cli("uninstall")
    if sandbox:
        sandbox.stop()
    provider.close()
    hashes = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in [root / "package.json", root / "bun.lock", runner, root / "scripts/verify-heartbeat.py", *sorted((root / "src").glob("heartbeat*.ts"))]}
    (artifacts / "receipt.json").write_text(json.dumps({"checks": checks, "hashes": hashes, "commands": commands, "label": label, "cleaned": not installed and (sandbox is None or sandbox.process.poll() is not None)}, indent=2))
