"""Isolated heartbeat verification; never uses the shared service, global config, or global LaunchAgents.

Scenarios:
  workflow  workflow and blocker holds, exact reminders, restarts, and CLI install and cleanup
  outage    an installed runner survives an OpenCode outage and reconnects through the refreshed registration
  ipv6      the outage scenario against an unchanged native IPv6 registration

--target is one package directory that provides both the plugin and bin/op-threads-heartbeat.mjs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid
import sandbox as sandbox_module
from sandbox import Sandbox, eventually
from fixture import Provider, code_mode_result, config, exposed, tool_call

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--target", type=Path, default=root)
parser.add_argument("--artifacts", type=Path, default=root / ".audit/recovery/heartbeat/native")
parser.add_argument("--scenario", action="append", choices=["workflow", "outage", "ipv6"])
options = parser.parse_args()
target = options.target.resolve()
runner = target / "bin/op-threads-heartbeat.mjs"
artifacts = options.artifacts.resolve()
artifacts.mkdir(parents=True, exist_ok=True)
domain = "gui/" + str(os.getuid())
checks = []
commands = []
labels = []
provider = Provider()
sandbox = None
installed = False
label = "com.opthreads.heartbeat.test-" + uuid.uuid4().hex
config_file = None

class IsolatedSandbox(Sandbox):
    def start(self):
        self.env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "fixture.txt").write_text("heartbeat fixture\n")
            subprocess.run(["git", "add", "."], cwd=self.directory, check=True, capture_output=True)
            subprocess.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], cwd=self.directory, check=True, capture_output=True)
        super().start()

class IPv6Sandbox(IsolatedSandbox):
    hostname = "::1"

def check(label, value=True):
    assert value, label
    checks.append(label)
    print("PASS:", label, flush=True)

def command(args):
    result = subprocess.run(args, cwd=root, text=True, capture_output=True, timeout=90)
    commands.append({"command": args, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
    (artifacts / "commands.json").write_text(json.dumps(commands, indent=2))
    return result

def cli(*args, success=True):
    result = command(["node", str(runner), *args, "--config", str(config_file)])
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

def start(kind, directory):
    global sandbox
    # Keep each sandbox root, not only its evidence, under the artifacts directory.
    original_mkdtemp = sandbox_module.tempfile.mkdtemp
    sandbox_module.tempfile.mkdtemp = lambda prefix, dir: original_mkdtemp(prefix=prefix, dir=artifacts)
    try:
        sandbox = kind(config(target, provider), directory)
    finally:
        sandbox_module.tempfile.mkdtemp = original_mkdtemp
    sandbox.await_plugin()
    return sandbox

def install(host):
    global installed
    result = cli("install", "--service-file", str(sandbox.root / "state/opencode/service.json"), "--host-directory", str(host), "--label", label, "--launchagents-directory", str(sandbox.root / "launchagents"))
    installed = True
    return result

def uninstall():
    global installed
    result = cli("uninstall")
    installed = False
    return result

def workflow():
    global config_file
    start(IsolatedSandbox, artifacts / "workflow")
    owner = sandbox.api("POST", "/api/session", {"permissions": [{"action": "heartbeat-fixture", "resource": "*", "effect": "ask"}]}, location=sandbox.directory)["data"]["id"]
    run = tool(owner, "workflows_start", {"key": "heartbeat-native", "script": 'export const meta = { name: "heartbeat", description: "fixture" }; return await checkpoint("Inspect", { key: "arbitrary", reviewer: "coordinator" });'})
    enrolled = tool(owner, "workflows_heartbeat_enroll", {"key": "native", "runID": run["id"], "deadlineAt": int(time.time() * 1000) + 600_000,
        "policy": {"cooldownMs": 1_000, "idleGraceMs": 1_000, "stalledMs": 1_000}})
    check("enrollment makes no immediate wake", enrolled["wakesReserved"] == 0)
    patched = tool(owner, "workflows_heartbeat_update", {"key": "native", "expectedRevision": enrolled["revision"], "change": {"type": "policy", "patch": {"maxWakes": 2}}})
    check("native registered maxWakes-only patch preserves custom intervals", patched["policy"] == {**enrolled["policy"], "maxWakes": 2})
    enrolled = patched
    host = sandbox.root / "host"
    host.mkdir()
    config_file = sandbox.root / "runner.json"
    config_file.write_text(json.dumps({"protocol": 1, "serviceFile": str(sandbox.root / "state/opencode/service.json"), "hostDirectory": str(host),
                   "node": shutil.which("node"), "runner": str(runner), "intervalMs": 60_000, "label": label, "launchAgentsDirectory": str(sandbox.root / "launchagents")}))
    snapshot = sandbox.api("POST", "/api/rpc/workflows-heartbeat/snapshot", {"input": {"limit": 100}}, location=host)["output"]
    check("cold host RPC activates plugin and reads coordinator checkpoint", snapshot["entries"][0]["run"]["checkpoints"][0]["reviewer"] == "coordinator")
    (sandbox.artifacts / "openapi.json").write_text(json.dumps(sandbox.api("GET", "/openapi.json"), indent=2))
    shadow = cli("once", "--shadow")
    check("actual Node shadow returns complete observation", shadow["decisions"][0]["observation"]["kind"] == "complete")
    after_shadow = sandbox.api("POST", "/api/rpc/workflows-heartbeat/snapshot", {"input": {}}, location=host)["output"]
    check("shadow is storage read-only", after_shadow == snapshot)
    time.sleep(1.1)

    def native_hold(field):
        observed = cli("once", "--shadow")["decisions"][0]
        (sandbox.artifacts / (field + "-observation.json")).write_text(json.dumps(observed, indent=2))
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
    (sandbox.artifacts / "permission-create.json").write_text(json.dumps(permission_result, indent=2))
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
    config_file.unlink()
    check("isolated LaunchAgent installer reads back task-owned label", label in install(host)["readback"]["stdout"])
    status = cli("status")
    check("actual status observes existing service and launcher", status["launcher"]["code"] == 0 and status["observation"]["available"])
    check("uninstall removes only task-owned launcher with negative readback", uninstall()["readback"]["code"] != 0 and not config_file.exists())

def outage(kind):
    global config_file
    start(kind, artifacts / ("ipv6" if kind is IPv6Sandbox else "outage"))
    name = "IPv6 " if kind is IPv6Sandbox else ""
    binary = Path(sandbox.binary).resolve()
    binary_sha = hashlib.sha256(binary.read_bytes()).hexdigest()
    service = sandbox.root / "state/opencode/service.json"
    before_bytes = service.read_bytes()
    before = json.loads(before_bytes)
    prefix = "http://127.0.0.1:"
    if kind is IPv6Sandbox:
        prefix = "http://::1:" if before["version"] == "2.0.26" else "http://[::1]:"
        listener = command(["/usr/sbin/lsof", "-nP", "-a", "-p", str(sandbox.process.pid), "-iTCP", "-sTCP:LISTEN"]).stdout
        check("OS confirms an IPv6 loopback listener", "IPv6" in listener and "[::1]:" in listener)
    check(f"unchanged native {before['version']} writes its expected {name}registration", before["url"].startswith(prefix))
    host = sandbox.root / "host"
    host.mkdir()
    config_file = sandbox.root / "runner.json"
    def lines(file):
        path = sandbox.root / file
        return path.read_text().splitlines() if path.exists() else []
    def runner_pid():
        result = command(["/bin/launchctl", "print", domain + "/" + label])
        assert result.returncode == 0, commands[-1]
        return int(re.search(r"\bpid = (\d+)", result.stdout)[1])
    install(host)
    eventually(lambda: len(lines("runner.log")) > 0)
    check(f"installed external Node runner completes a real {name}tick", json.loads(lines("runner.log")[-1]) == {"protocol": 1, "shadow": False, "decisions": []})
    check(f"runner leaves the native {name}registration byte-identical", service.read_bytes() == before_bytes)
    pid = runner_pid()
    before_ticks = len(lines("runner.log"))
    before_errors = len(lines("runner.error.log"))
    sandbox.stop()
    eventually(lambda: len(lines("runner.error.log")) > before_errors, timeout=80)
    check(f"same {name}runner survives outage without starting a service", runner_pid() == pid and not service.exists() and sandbox.process.poll() is not None)
    check(f"{name}outage tick reports connect-only failure", "connect-only" in json.loads(lines("runner.error.log")[-1])["unavailable"])
    sandbox.start()
    after_bytes = service.read_bytes()
    after = json.loads(after_bytes)
    check(f"native restart refreshes {name}PID and URL", after["pid"] != before["pid"] and after["url"] != before["url"] and after["url"].startswith(prefix))
    eventually(lambda: len(lines("runner.log")) > before_ticks, timeout=80)
    check(f"same external {name}runner reconnects through fresh registration", runner_pid() == pid and json.loads(lines("runner.log")[-1]) == {"protocol": 1, "shadow": False, "decisions": []})
    check(f"refreshed {name}registration remains byte-identical", service.read_bytes() == after_bytes)
    check(f"installed OpenCode executable remains unchanged after {name}outage", hashlib.sha256(binary.read_bytes()).hexdigest() == binary_sha)
    uninstall()

scenarios = {"workflow": workflow, "outage": lambda: outage(IsolatedSandbox), "ipv6": lambda: outage(IPv6Sandbox)}
try:
    # Keep scenarios sequential: each owns one sandbox and at most one task-owned LaunchAgent label.
    for scenario in options.scenario or list(scenarios):
        label = "com.opthreads.heartbeat.test-" + uuid.uuid4().hex
        labels.append(label)
        scenarios[scenario]()
        sandbox.stop()
finally:
    if installed:
        uninstall()
    if sandbox:
        sandbox.stop()
    provider.close()
    hashes = {str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest() for path in [target / "package.json", runner, *sorted((target / "src").glob("heartbeat*.ts"))]}
    hashes["scripts/verify-heartbeat.py"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    absent = all(command(["/bin/launchctl", "print", domain + "/" + item]).returncode != 0 for item in labels)
    (artifacts / "receipt.json").write_text(json.dumps({"target": str(target), "checks": checks, "hashes": hashes, "commands": commands, "labels": labels,
        "cleaned": not installed and absent and (sandbox is None or sandbox.process.poll() is not None)}, indent=2))
