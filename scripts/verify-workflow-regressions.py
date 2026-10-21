import argparse
import json
from pathlib import Path
import time

from fixture import Provider, config, decoded, run_tool, source_fingerprint
from sandbox import Sandbox, eventually


root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("target", nargs="?", type=Path, default=root)
parser.add_argument("--case", action="append")
options = parser.parse_args()
target = options.target.resolve()
artifacts = root / ".audit" / "workflow-regressions"
artifacts.mkdir(parents=True, exist_ok=True)


provider = Provider()
settings = config(target, provider)
settings["agents"] = {"regression-role": {"mode": "subagent", "steps": 10, "permissions": [{"action": "*", "resource": "*", "effect": "allow"}]}}
sandbox = None
observations = []
verified_source = source_fingerprint(target)


def messages(session):
    try:
        return sandbox.api("GET", f"/api/session/{session}/message?limit=100")["data"]
    except RuntimeError as error:
        if "404" in str(error):
            return []
        raise


def tool(session, name, arguments):
    return decoded(run_tool(sandbox, provider, session, name, arguments))


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


def assistant_prefill_script_retry():
    marker = "REGRESSION_PREFILL_FAILURE"
    provider.responses[marker] = {
        "error_once_after_tool": True,
        "name": "read",
        "arguments": {"path": str(sandbox.directory / "README.md")},
    }
    report("REGRESSION_PREFILL_RETRY", {"recovered": True})
    run = start("assistant-prefill-script-retry", f'''try {{ return await agent("{marker}", {{key:"prefill",agent:"regression-role",access:"write",directory:"{sandbox.directory}"}}); }}
catch (error) {{ return {{ error: error.message, retried: await agent("REGRESSION_PREFILL_RETRY", {{key:"prefill-retry",agent:"regression-role",access:"write",directory:"{sandbox.directory}"}}) }}; }}''')
    final = settled(run)
    assert [step["status"] for step in final["steps"]] == ["failed", "completed"], final
    assert final["result"]["retried"] == {"recovered": True}, final
    assert "before a valid workflows_result report" in final["result"]["error"], final
    worker_messages = messages(final["steps"][0]["workerID"])
    failures = [m for m in worker_messages if m["type"] == "assistant" and "prefill" in str(m.get("error", ""))]
    prompts = [m for m in worker_messages if m["type"] == "synthetic"]
    assert len(failures) == 1 and not prompts, worker_messages
    return {"worker": final["steps"][0]["workerID"], "failures": len(failures), "retry": final["steps"][1]["workerID"]}


def assistant_prefill_fails_step():
    marker = "REGRESSION_PREFILL_PERSISTENT"
    provider.responses[marker] = {
        "error_once_after_tool": True,
        "name": "read",
        "arguments": {"path": str(sandbox.directory / "README.md")},
    }
    run = start("assistant-prefill-fails-step", f'''return await agent("{marker}", {{key:"prefill",agent:"regression-role",access:"write",directory:"{sandbox.directory}"}});''')
    final = settled(run, "failed")
    step = final["steps"][0]
    worker_messages = messages(step["workerID"])
    failures = [m for m in worker_messages if m["type"] == "assistant" and "prefill" in str(m.get("error", ""))]
    prompts = [m for m in worker_messages if m["type"] == "synthetic"]
    assert len(failures) == 1 and not prompts and step["status"] == "failed", final
    assert "before a valid workflows_result report" in final.get("error", ""), final
    return {"worker": step["workerID"], "failures": len(failures)}


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


def owner_attention():
    run = start("owner-attention", 'return await checkpoint("Approve the next phase?", {key:"human-approval"});')
    waiting = settled(run, "waiting")
    assert waiting["checkpoints"][0].get("response") is None, waiting

    def notices():
        return [message for message in messages(owner) if message["type"] == "synthetic"
                and run["id"] in message.get("text", "")
                and "human-approval" in message.get("text", "")]

    first = eventually(lambda: notices())
    assert len(first) == 1 and "Approve the next phase?" in first[0]["text"], first
    assert "resume" in first[0]["text"].lower(), first
    restart(hard=True)
    recovered = inspect(run)
    assert recovered["status"] == "interrupted", recovered
    assert recovered["checkpoints"][0].get("response") is None, recovered
    attention = eventually(lambda: (items if len(items := notices()) >= 2 else None))
    assert len(attention) == 2, attention
    interrupted = next(message for message in attention if message["id"] != first[0]["id"])
    assert "interrupt" in interrupted["text"].lower(), interrupted
    for _ in range(3):
        inspect(run)
    assert {message["id"] for message in notices()} == {message["id"] for message in attention}
    control(run, action="resume")
    settled(run, "waiting")
    restart()
    assert inspect(run)["status"] == "interrupted"
    try:
        repeated = eventually(lambda: (items if len(items := notices()) >= 3 else None))
    except TimeoutError:
        (artifacts / "repeated-interruption.json").write_text(json.dumps({
            "run": inspect(run), "notices": notices(),
            "inbox": sandbox.api("GET", f"/api/session/{owner}/inbox"),
            "owner": sandbox.api("GET", f"/api/session/{owner}"),
        }, indent=2))
        raise
    assert len(repeated) == 3 and len({message["id"] for message in repeated}) == 3, repeated
    assert sum("checkpoint requires" in message["text"] for message in repeated) == 1, repeated
    control(run, action="resume", checkpointKey="human-approval", response=False)
    final = settled(run)
    assert final["result"] is False and not final["steps"], final
    return {"waitingNotice": first[0], "interruptionNotices": repeated[1:], "run": final}


def followup_handoff():
    report("FOLLOWUP_INITIAL", "original-result")
    run = start("followup-handoff", 'return await agent("FOLLOWUP_INITIAL", {key:"worker",agent:"regression-role",access:"write"});')
    original = settled(run)
    worker = original["steps"][0]["workerID"]
    effect = sandbox.directory / "followup-effect.txt"
    provider.responses["FOLLOWUP_EFFECT"] = {
        "name": "shell", "arguments": {"command": "printf 'one effect\\n' >> followup-effect.txt"},
    }
    request = {"workerID": worker, "key": "followup-effect", "text": "FOLLOWUP_EFFECT"}
    sent = tool(owner, "threads_send", request)

    def notices():
        return [message for message in messages(owner) if message["type"] == "synthetic"
                and worker in json.dumps(message) and sent["messageID"] in json.dumps(message)]

    notice = eventually(lambda: notices())
    assert len(notice) == 1, notice
    eventually(lambda: worker not in sandbox.api("GET", "/api/session/active")["data"])
    assert effect.read_text() == "one effect\n"
    assert inspect(run)["steps"][0]["report"] == original["steps"][0]["report"]
    assert tool(owner, "threads_send", request) == sent
    restart()
    tool(owner, "threads_list", {})
    assert tool(owner, "threads_send", request) == sent
    assert effect.read_text() == "one effect\n"
    assert [message["id"] for message in notices()] == [notice[0]["id"]]
    assert inspect(run)["steps"][0]["report"] == original["steps"][0]["report"]
    return {"run": original, "send": sent, "notice": notice[0], "effect": effect.read_text()}


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


def saved_commands():
    directory = sandbox.directory / ".opencode/workflows"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "command-example.js").write_text(script("command-example", "return args.value + 1;"))
    before = len(provider.requests)
    sandbox.api("POST", f"/api/session/{owner}/command", {"name": "workflow-refresh", "text": ""})
    commands = sandbox.api("GET", "/api/command", location=sandbox.directory)["data"]
    names = {command["name"] for command in commands}
    assert {"workflow-run", "workflow-refresh"} <= names, commands
    assert "workflow-command-example" not in names, commands
    assert len(provider.requests) == before, "Refresh unexpectedly generated a model request"
    return sorted(name for name in names if name.startswith("workflow-"))


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


def optional_budgets():
    for index in range(9):
        report(f"UNBOUNDED_STEP_{index}", index)
    run = settled(start("unbounded-steps", '''return await pipeline(Array.from({length:9}, (_, i) => i),
        i => agent("UNBOUNDED_STEP_"+i, {key:"item:"+i, agent:"regression-role"}));''', concurrency=1))
    assert run["result"] == list(range(9)) and len(run["steps"]) == 9, run
    assert all(run["limits"].get(field) is None for field in ["maxAgents", "agentTimeoutMs", "timeoutMs", "tokenBudget"]), run
    finite = settled(start("explicit-step-budget", '''const results=[]; for (const i of [0,1,2])
        results.push(await agent("UNBOUNDED_STEP_"+i, {key:"item:"+i, agent:"regression-role"})); return results;''', concurrency=1, maxAgents=2), "failed")
    assert sum(step["status"] == "completed" for step in finite["steps"]) == 2, finite
    cancellable = start("unbounded-cancel", 'await log("unbounded-running"); while (true) {}')
    eventually(lambda: any(entry["text"] == "unbounded-running" for entry in inspect(cancellable)["logs"]))
    started = time.monotonic()
    control(cancellable, action="stop")
    stopped = settled(cancellable, "stopped")
    assert time.monotonic() - started < 5, stopped
    return {"unbounded": run, "explicitBudget": finite, "cancelled": stopped}


def configured_defaults():
    previous = start("previous-default", 'return await checkpoint("Continue", {key:"continue"});')
    previous_limits = settled(previous, "waiting")["limits"]
    assert previous_limits["concurrency"] == 3 and previous_limits.get("maxAgents") is None
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
    "assistant-prefill-script-retry": assistant_prefill_script_retry,
    "assistant-prefill-fails-step": assistant_prefill_fails_step,
    "queued-budget": token_budget,
    "failed-usage": failed_usage,
    "checkpoint-state": checkpoint_state,
    "owner-attention": owner_attention,
    "followup-handoff": followup_handoff,
    "checkpoint-replay": checkpoint_replay,
    "reported-crash": reported_crash,
    "saved-nested": saved_and_nested,
    "saved-commands": saved_commands,
    "nesting-limit": nesting_limit,
    "worktree-handoff": worktree_handoff,
    "runtime-deadline": runtime_deadline,
    "optional-budgets": optional_budgets,
    "configured-defaults": configured_defaults,
}
selected = options.case or list(cases)
assert all(name in cases for name in selected), selected
try:
    sandbox = Sandbox(settings, artifacts, repository="Workflow regression fixture\n")
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
    assert source_fingerprint(target) == verified_source, "Source changed during verification"
finally:
    provider.release.set()
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2))
    if sandbox:
        sandbox.stop()
    provider.close()
assert all(item["status"] == "PASS" for item in observations), "Native workflow regressions failed"
print(f"PASS: {len(observations)} native regression cases; {artifacts}")
