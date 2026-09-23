import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

from fixture import Provider, config
from sandbox import Sandbox, eventually


root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("target", nargs="?", type=Path, default=root)
parser.add_argument("--case", action="append")
options = parser.parse_args()
target = options.target.resolve()
artifacts = root / ".audit" / "workflow-regressions"
artifacts.mkdir(parents=True, exist_ok=True)


def source_hash():
    digest = hashlib.sha256()
    for path in [target / "index.ts", target / "tui.ts", target / "package.json", *sorted((target / "src").glob("*.ts")), *sorted((target / "src").glob("*.tsx"))]:
        digest.update(str(path.relative_to(target)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


class WorkflowSandbox(Sandbox):
    def start(self):
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "README.md").write_text("Workflow regression fixture\n")
            subprocess.run(["git", "add", "README.md"], cwd=self.directory, check=True)
            subprocess.run(["git", "-c", "user.name=Workflow fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"], cwd=self.directory, check=True, capture_output=True)
        super().start()


provider = Provider()
settings = config(target, provider)
settings["agents"] = {"regression-role": {"mode": "subagent", "steps": 10, "permissions": [{"action": "*", "resource": "*", "effect": "allow"}]}}
sandbox = None
observations = []
verified_source = source_hash()


def messages(session):
    try:
        return sandbox.api("GET", f"/api/session/{session}/message?limit=100")["data"]
    except RuntimeError as error:
        if "404" in str(error):
            return []
        raise


def tool(session, name, arguments):
    def results():
        return [part for message in messages(session) if message["type"] == "assistant" for part in message["content"]
                if part["type"] == "tool" and part["name"] == name and part["state"]["status"] in ["completed", "error"]]
    before = {part["id"] for part in results()}
    marker = f"REGRESSION_TOOL_{uuid.uuid4().hex}"
    provider.responses[marker] = {"name": name, "arguments": arguments}
    sandbox.api("POST", f"/api/session/{session}/prompt", {"text": marker})
    result = eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60)
    eventually(lambda: session not in sandbox.api("GET", "/api/session/active")["data"])
    assert result["state"]["status"] == "completed", result
    return json.loads(result["state"]["content"][0]["text"])


def script(name, body):
    return f'export const meta = {{ name: "{name}", description: "Native regression" }};\n{body}'


def start(name, body, **limits):
    return tool(owner, "workflows_start", {"key": name, "script": script(name, body), **limits})


def inspect(run):
    return sandbox.api("POST", "/api/rpc/workflows/inspect", {"input": {"ownerID": owner, "runID": run["id"]}}, location=sandbox.directory)["output"]


def control(run, **value):
    return sandbox.api("POST", "/api/rpc/workflows/control", {"input": {"ownerID": owner, "runID": run["id"], **value}}, location=sandbox.directory)["output"]


def settled(run, status="completed"):
    def check():
        current = inspect(run)
        if current["status"] in ["completed", "failed", "stopped"] and current["status"] != status:
            raise AssertionError(current)
        return current if current["status"] == status else None
    return eventually(check, timeout=60)


def report(marker, value):
    provider.responses[marker] = {"name": "workflows_result", "arguments": {
        "verdict": "PASS", "summary": "Native regression result", "evidence": ["deterministic provider"], "result": value,
    }}


def restart(hard=False):
    if hard:
        sandbox.process.kill()
        sandbox.process.wait()
    sandbox.stop()
    provider.release.set()
    sandbox.start()
    sandbox.await_plugin()


def token_budget():
    for index in range(3):
        report(f"QUEUED_BUDGET_{index}", index)
    run = start("queued-budget", '''return await parallel([0,1,2].map(index => () => agent("QUEUED_BUDGET_"+index, {
        key:"item:"+index, agent:"regression-role"
    })));''', concurrency=1, maxAgents=3, tokenBudget=1)
    final = settled(run, "failed")
    completed = [step for step in final["steps"] if step["status"] == "completed"]
    assert len(completed) == 1, final
    assert "budget" in final.get("error", "").lower(), final
    return final


def failed_usage():
    provider.responses["FAILED_USAGE_FIRST"] = {"name": "read", "arguments": {"path": str(sandbox.directory / "README.md")}}
    report("FAILED_USAGE_NEXT", "must not start")
    run = start("failed-usage", '''try { await agent("FAILED_USAGE_FIRST", {key:"first", agent:"regression-role"}); } catch {}
    return await agent("FAILED_USAGE_NEXT", {key:"next", agent:"regression-role"});''', tokenBudget=1)
    final = settled(run, "failed")
    first = next(step for step in final["steps"] if step["key"] == "first")
    native = sandbox.api("GET", f'/api/session/{first["workerID"]}')["data"]
    expected = native["tokens"]["input"] + native["tokens"]["output"]
    assert expected > 1, native
    assert first.get("usage", {}).get("measured") and first["usage"]["tokens"] == expected, final
    for step in final["steps"]:
        if step["key"] != "next":
            continue
        assert step["status"] == "prepared", final
        try:
            sandbox.api("GET", f'/api/session/{step["workerID"]}')
        except RuntimeError as error:
            assert "404" in str(error), error
        else:
            raise AssertionError("Budget-exhausted successor created a native session")
    return {"run": final, "nativeTokens": expected}


def checkpoint_state():
    run = start("checkpoint-state", 'return await parallel([() => checkpoint("First", {key:"a"}), () => checkpoint("Second", {key:"b"})]);')
    eventually(lambda: len(inspect(run)["checkpoints"]) == 2)
    partial = control(run, action="resume", checkpointKey="a", response=True)
    assert partial["status"] == "waiting", partial
    control(run, action="resume", checkpointKey="b", response=False)
    final = settled(run)
    assert final["result"] == [True, False], final
    return final


def checkpoint_replay():
    report("ORDER_B_A", "b,a")
    report("ORDER_A_B", "a,b")
    run = start("checkpoint-order", '''const order=[];
    await parallel([
        async () => { await checkpoint("A", {key:"a"}); order.push("A"); await log("a-observed"); },
        async () => { await checkpoint("B", {key:"b"}); order.push("B"); await log("b-observed"); }
    ]);
    const value=await agent("ORDER_"+order.join("_"), {key:"consumer",agent:"regression-role"});
    await checkpoint("Restart", {key:"hold"}); return value;''')
    eventually(lambda: len(inspect(run)["checkpoints"]) == 2)
    control(run, action="resume", checkpointKey="b", response=True)
    eventually(lambda: any(entry["text"] == "b-observed" for entry in inspect(run)["logs"]))
    control(run, action="resume", checkpointKey="a", response=True)
    before = eventually(lambda: (r if (r := inspect(run)) and any(c["key"] == "hold" for c in r["checkpoints"]) else None))
    restart()
    control(run, action="resume", checkpointKey="hold", response=True)
    final = settled(run)
    assert final["result"] == "b,a", final
    assert final["steps"][0]["workerID"] == before["steps"][0]["workerID"], final
    return final


def failed_replay():
    provider.responses["ATTEMPT_MISSING"] = {"name": "read", "arguments": {"path": str(sandbox.directory / "README.md")}}
    report("ATTEMPT_FALLBACK", "fallback")
    report("The previous native execution failed before a valid workflows_result report was recorded.", "changed-branch")
    run = start("failed-outcome-replay", '''let value;
    try { value=await agent("ATTEMPT_MISSING", {key:"t1",agent:"regression-role"}); }
    catch { value=await agent("ATTEMPT_FALLBACK", {key:"t2",agent:"regression-role"}); }
    await checkpoint("Restart", {key:"hold"}); return value;''', timeoutMs=15000, maxAgents=2)
    settled(run, "waiting")
    restart()
    started = time.monotonic()
    control(run, action="resume", checkpointKey="hold", response=True)
    final = settled(run, "failed")
    elapsed = time.monotonic() - started
    assert elapsed < 5, {"elapsed": elapsed, "run": final}
    first = next(step for step in final["steps"] if step["key"] == "t1")
    assert first["status"] == "failed", final
    assert "timed" not in final.get("error", "").lower() and "fibers interrupted" not in final.get("error", ""), final
    return {"run": final, "resumeSeconds": elapsed}


def reported_crash():
    provider.release.clear()
    value = {"verdict": "PASS", "summary": "Write already verified", "evidence": ["reported-write.txt"], "result": "durable"}
    provider.responses["REPORT_THEN_CRASH"] = {"sequence": [
        {"name": "shell", "arguments": {"command": "printf 'one effect\\n' >> reported-write.txt"}},
        {"name": "workflows_result", "arguments": value},
        {"name": "read", "wait": True, "arguments": {"path": str(sandbox.directory / "README.md")}},
    ]}
    run = start("reported-crash", 'return await agent("REPORT_THEN_CRASH", {key:"write",agent:"regression-role",access:"write"});')
    worker = eventually(lambda: next((step["workerID"] for step in inspect(run)["steps"] if step["status"] == "running"), None))
    eventually(lambda: next((part for message in messages(worker) if message["type"] == "assistant" for part in message["content"]
        if part["type"] == "tool" and part["name"] == "workflows_result" and part["state"]["status"] == "completed"), None))
    eventually(lambda: any("REPORT_THEN_CRASH" in json.dumps(request) and any(m.get("role") == "tool" and "accepted" in str(m.get("content", "")) for m in request.get("messages", [])) for request in provider.requests))
    before = len(provider.requests)
    restart(hard=True)
    recovered = inspect(run)
    assert recovered["status"] == "interrupted" and len(provider.requests) == before, recovered
    control(run, action="resume")
    unresolved = settled(run, "interrupted")
    assert (sandbox.directory / "reported-write.txt").read_text() == "one effect\n", unresolved
    provider.responses["RESOLVE_RECORDED_WRITE"] = {"name": "workflows_result", "arguments": value}
    tool(owner, "threads_send", {"workerID": worker, "key": "resolve-recorded-write", "text": "RESOLVE_RECORDED_WRITE. Inspect the existing effect and acknowledge the identical stored result. Do not repeat the write."})
    eventually(lambda: worker not in sandbox.api("GET", "/api/session/active")["data"])
    control(run, action="resume")
    final = settled(run)
    assert final["result"] == "durable" and final["steps"][0]["workerID"] == worker, final
    assert (sandbox.directory / "reported-write.txt").read_text() == "one effect\n", final
    return final


def saved_and_nested():
    seed = start("saved-source", "return args.value * 2;", args={"value": 1})
    settled(seed)
    tool(owner, "workflows_save", {"runID": seed["id"], "name": "double-value", "scope": "project"})
    reuse = tool(owner, "workflows_start", {"key": "saved-reuse", "name": "double-value", "args": {"value": 7}})
    assert settled(reuse)["result"] == 14
    child = sandbox.directory / ".opencode/workflows/pinned-child.js"
    child.write_text(script("pinned-child", 'await checkpoint("Nested gate", {key:"gate"}); return args.value;'))
    run = start("nested-pin", 'return await workflow("pinned-child", {value:17});')
    before = settled(run, "waiting")
    child.write_text(script("pinned-child", "return 999;"))
    restart()
    control(run, action="resume", checkpointKey=before["checkpoints"][0]["key"], response=True)
    final = settled(run)
    assert final["result"] == 17, final
    return final


def native_helpers():
    for index in [1, 2]:
        report(f"HELPER_GATE_{index}", index == 2)
    for index in [1, 2, 3]:
        report(f"HELPER_DRY_{index}", [{"id": "one"}] if index == 1 else [])
    report("HELPER_RETRY", "retried")
    run = start("native-helpers", '''const gated=await gate(
        attempt => agent("HELPER_GATE_"+attempt, {key:"gate:"+attempt,agent:"regression-role"}), value => value);
    const retried=await retry(async attempt => {
        if (attempt===1) throw new Error("logical retry");
        return agent("HELPER_RETRY", {key:"retry:"+attempt,agent:"regression-role"});
    });
    const found=await loopUntilDry({key:"id",round:round => agent("HELPER_DRY_"+round,{key:"dry:"+round,agent:"regression-role"})});
    return {gated,retried,found};''', maxAgents=6)
    final = settled(run)
    assert final["result"] == {"gated": True, "retried": "retried", "found": [{"id": "one"}]}, final
    assert len(final["steps"]) == 6, final
    return final


def saved_commands():
    directory = sandbox.directory / ".opencode/workflows"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "command-example.js").write_text(script("command-example", "return args.value + 1;"))
    before = len(provider.requests)
    sandbox.api("POST", f"/api/session/{owner}/command", {"name": "workflow-refresh", "text": ""})
    commands = sandbox.api("GET", "/api/command", location=sandbox.directory)["data"]
    assert any(command["name"] == "workflow-command-example" for command in commands), commands
    assert len(provider.requests) == before, "Refresh unexpectedly generated a model request"
    marker = "SAVED_COMMAND_INVOCATION"
    provider.responses[marker] = {"name": "workflows_start", "arguments": {"key": "command-example-run", "name": "command-example", "args": {"value": 9}}}
    sandbox.api("POST", f"/api/session/{owner}/command", {"name": "workflow-command-example", "text": marker})
    def started_run():
        for message in messages(owner):
            if message["type"] != "assistant":
                continue
            for part in message["content"]:
                if part["type"] == "tool" and part["name"] == "workflows_start" and part["state"]["status"] == "completed":
                    return json.loads(part["state"]["content"][0]["text"])
        return None
    run = eventually(started_run)
    final = settled(run)
    assert final["result"] == 10, final
    return final


def nesting_limit():
    directory = sandbox.directory / ".opencode/workflows"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "recursive-child.js").write_text(script("recursive-child", 'return await workflow("recursive-child");'))
    run = start("nesting-limit", 'return await workflow("recursive-child");')
    final = settled(run, "failed")
    assert "depth limit" in final.get("error", "").lower(), final
    assert not final["steps"], final
    return final


def worktree_handoff():
    provider.release.clear()
    write_report = {"verdict": "PASS", "summary": "Wrote retained proof", "evidence": ["handoff-proof.txt"], "result": {"directory": "pending"}}
    provider.responses["HANDOFF_WRITER"] = {"sequence": [
        {"name": "shell", "wait": True, "arguments": {"command": "printf 'verified write\\n' > handoff-proof.txt"}},
        {"name": "workflows_result", "arguments": write_report},
    ]}
    provider.responses["HANDOFF_VERIFIER"] = {"sequence": [
        {"name": "shell", "arguments": {"command": "test \"$(cat handoff-proof.txt)\" = 'verified write'"}},
        {"name": "workflows_result", "arguments": {"verdict": "PASS", "summary": "Verified retained proof", "evidence": ["handoff-proof.txt"], "result": True}},
    ]}
    run = start("worktree-handoff", '''const written=await agent("HANDOFF_WRITER", {key:"write",agent:"regression-role",access:"write",isolation:"worktree"});
    return await agent("HANDOFF_VERIFIER", {key:"verify",agent:"regression-role",access:"write",directory:written.directory});''', maxAgents=2)
    step = eventually(lambda: next((s for s in inspect(run)["steps"] if s["status"] == "running"), None))
    write_report["result"]["directory"] = step["directory"]
    provider.release.set()
    final = settled(run)
    assert final["result"] is True and final["steps"][0]["directory"] == final["steps"][1]["directory"], final
    assert not (sandbox.directory / "handoff-proof.txt").exists(), final
    shells = [part for message in messages(final["steps"][1]["workerID"]) if message["type"] == "assistant"
              for part in message["content"] if part["type"] == "tool" and part["name"] == "shell"]
    assert len(shells) == 1 and shells[0]["state"].get("metadata", {}).get("exit") == 0, shells
    return {"run": final, "verificationShell": shells[0]}


def configured_defaults():
    previous = start("previous-default", 'return await checkpoint("Continue", {key:"continue"});')
    previous_limits = settled(previous, "waiting")["limits"]
    assert previous_limits["concurrency"] == 3 and previous_limits["maxAgents"] == 4
    config_path = sandbox.root / "config/opencode/opencode.json"
    original = config_path.read_text()
    configured = json.loads(original)
    configured["plugins"] = [
        {"package": entry, "options": {"workflowConcurrency": 8, "workflowMaxAgents": 8}} if entry == str(target) else entry
        for entry in configured["plugins"]
    ]
    sandbox.stop()
    config_path.write_text(json.dumps(configured))
    try:
        sandbox.start()
        sandbox.await_plugin()
        for index in range(8):
            report(f"CONFIG_DEFAULT_{index}", index)
        inherited = settled(start("configured-default", '''return await parallel(Array.from({length:8}, (_, i) =>
            () => agent("CONFIG_DEFAULT_"+i, {key:"item:"+i, agent:"regression-role"})));'''))
        explicit = settled(start("explicit-defaults", "return true;", concurrency=2, maxAgents=2))
        assert inherited["limits"]["concurrency"] == 8 and inherited["limits"]["maxAgents"] == 8, inherited
        assert inherited["result"] == list(range(8)) and len(inherited["steps"]) == 8, inherited
        assert explicit["limits"]["concurrency"] == 2 and explicit["limits"]["maxAgents"] == 2, explicit
        control(previous, action="resume", checkpointKey="continue", response=True)
        resumed = settled(previous)
        assert resumed["limits"] == previous_limits and resumed["result"] is True, resumed
        return {"configured": inherited, "explicit": explicit, "resumed": resumed}
    finally:
        sandbox.stop()
        config_path.write_text(original)
        sandbox.start()
        sandbox.await_plugin()


def runtime_deadline():
    run = start("cpu-deadline", 'await log("cpu-started"); while (true) { /^(a+)+$/.test(' + json.dumps("a" * 34 + "!") + '); }', timeoutMs=1000)
    eventually(lambda: any(entry["text"] == "cpu-started" for entry in inspect(run)["logs"]))
    started = time.monotonic()
    current = inspect(run)
    response_seconds = time.monotonic() - started
    assert response_seconds < 0.5, {"responseSeconds": response_seconds, "status": current["status"]}
    final = settled(run, "failed")
    assert any(text in final.get("error", "").lower() for text in ["timed out", "timeout"]), final
    assert time.monotonic() - started < 2, final
    return {"run": final, "responseSecondsDuringRegex": response_seconds}


cases = {
    "queued-budget": token_budget,
    "failed-usage": failed_usage,
    "checkpoint-state": checkpoint_state,
    "checkpoint-replay": checkpoint_replay,
    "failed-replay": failed_replay,
    "reported-crash": reported_crash,
    "saved-nested": saved_and_nested,
    "native-helpers": native_helpers,
    "saved-commands": saved_commands,
    "nesting-limit": nesting_limit,
    "worktree-handoff": worktree_handoff,
    "runtime-deadline": runtime_deadline,
    "configured-defaults": configured_defaults,
}
selected = options.case or list(cases)
assert all(name in cases for name in selected), selected
try:
    sandbox = WorkflowSandbox(settings, artifacts)
    sandbox.await_plugin()
    for name in selected:
        owner = sandbox.api("POST", "/api/session", {"title": f"Workflow regression: {name}", "location": {"directory": str(sandbox.directory)}})["data"]["id"]
        try:
            evidence = cases[name]()
            observations.append({"case": name, "status": "PASS", "evidence": evidence})
            print(f"PASS: {name}", flush=True)
        except Exception as error:
            observations.append({"case": name, "status": "FAIL", "error": str(error)})
            print(f"FAIL: {name}: {error}", flush=True)
            provider.release.set()
            runs = sandbox.api("POST", "/api/rpc/workflows/snapshot", {"input": {"ownerID": owner}}, location=sandbox.directory)["output"]["runs"]
            for run in runs:
                if run["status"] not in ["completed", "failed", "stopped"]:
                    control(run, action="stop")
        finally:
            (artifacts / "evidence.json").write_text(json.dumps({"sourceHash": verified_source, "target": str(target), "cases": observations}, indent=2))
    assert source_hash() == verified_source, "Source changed during verification"
finally:
    provider.release.set()
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2))
    if sandbox:
        sandbox.stop()
    provider.close()
assert all(item["status"] == "PASS" for item in observations), "Native workflow regressions failed"
print(f"PASS: {len(observations)} native regression cases; {artifacts}")
