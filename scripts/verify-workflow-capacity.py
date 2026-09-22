"""Deterministic native capacity probe for dynamic workflows.

Runs an isolated OpenCode V2 service and local fixture provider. No paid model is
used. Artifacts are written under .audit/workflow-capacity (gitignored).
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

from fixture import Provider, config
from sandbox import Sandbox, eventually


ROOT = Path(__file__).resolve().parent.parent


def source_hash(target):
    digest = hashlib.sha256()
    for path in [target / "index.ts", target / "tui.ts", target / "package.json", *sorted((target / "src").glob("*.ts")), *sorted((target / "src").glob("*.tsx"))]:
        digest.update(str(path.relative_to(target)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


class CountingGate:
    """Event-compatible gate that measures fixture requests blocked in wait()."""

    def __init__(self):
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.active = 0
        self.peak = 0

    def wait(self, timeout=None):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            return self.event.wait(timeout)
        finally:
            with self.lock:
                self.active -= 1

    def set(self):
        self.event.set()

    def clear(self):
        self.event.clear()
        with self.lock:
            assert self.active == 0, "cannot reset a gate with active requests"
            self.peak = 0

    def snapshot(self):
        with self.lock:
            return {"active": self.active, "peak": self.peak}


class WorkflowSandbox(Sandbox):
    def start(self):
        if not (self.directory / ".git").exists():
            subprocess.run(["git", "init", "-b", "main", str(self.directory)], check=True, capture_output=True)
            (self.directory / "README.md").write_text("Capacity fixture\n")
            subprocess.run(["git", "add", "README.md"], cwd=self.directory, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Capacity fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"],
                cwd=self.directory, check=True, capture_output=True,
            )
        super().start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default=str(ROOT))
    parser.add_argument("--steps", type=int, default=128, help="sustained native steps (8..1000)")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    if not 8 <= args.steps <= 1000:
        parser.error("--steps must be between 8 and 1000")

    target = Path(args.target).resolve()
    verified_source = source_hash(target)
    artifacts = ROOT / ".audit" / "workflow-capacity"
    artifacts.mkdir(parents=True, exist_ok=True)
    provider = Provider()
    gate = CountingGate()
    provider.release = gate
    sandbox = None
    checks = []
    metrics = {"requestedSteps": args.steps, "scenarios": {}}

    def passed(label):
        checks.append(label)
        print(f"PASS: {label}", flush=True)

    def messages(session_id):
        return sandbox.api("GET", f"/api/session/{session_id}/message?limit=100")["data"]

    def run_tool(session_id, name, arguments):
        def results():
            return [
                part for message in messages(session_id) if message["type"] == "assistant"
                for part in message["content"] if part["type"] == "tool" and part["name"] == name
                and part["state"]["status"] in ["completed", "error"]
            ]

        before = {part["id"] for part in results()}
        marker = f"FIXTURE_{uuid.uuid4().hex}"
        provider.responses[marker] = {"name": name, "arguments": arguments}
        sandbox.api("POST", f"/api/session/{session_id}/prompt", {"text": marker})
        output = eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60)
        eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"], timeout=60)
        return output

    def decoded(part):
        assert part["state"]["status"] == "completed", part
        return json.loads(part["state"]["content"][0]["text"])

    def inspect(owner, run_id):
        return sandbox.api("POST", "/api/rpc/workflows/inspect", {
            "input": {"ownerID": owner, "runID": run_id},
        }, location=sandbox.directory)["output"]

    def settled(owner, run_id, expected="completed", timeout=None):
        def result():
            run = inspect(owner, run_id)
            if run["status"] in ["completed", "failed", "stopped"] and run["status"] != expected:
                raise AssertionError(run)
            return run if run["status"] == expected else None
        return eventually(result, timeout=timeout or args.timeout)

    def script(name, body):
        return f'export const meta = {{ name: "{name}", description: "Capacity verification" }};\n{body}'

    def report(marker, result, wait=False):
        provider.responses[marker] = {"name": "workflows_result", "wait": wait, "arguments": {
            "verdict": "PASS", "summary": "Deterministic capacity result",
            "evidence": [marker], "result": result,
        }}

    def start(owner, key, body, **limits):
        payload = {"key": key, "script": script(key, body), **limits}
        return decoded(run_tool(owner, "workflows_start", payload))

    def marker_requests(prefix):
        return sum(prefix in json.dumps(request) for request in provider.requests)

    def initial_marker_requests(prefix):
        return sum(
            prefix in json.dumps(request)
            and not any(message.get("role") == "tool" for message in request.get("messages", []))
            for request in provider.requests
        )

    def rss_bytes():
        output = subprocess.check_output(["ps", "-o", "rss=", "-p", str(sandbox.process.pid)], text=True).strip()
        return int(output) * 1024 if output else None

    try:
        if target != ROOT:
            raise ValueError("capacity wrapper is pinned to this checkout; run without a target override")
        settings = config(str(ROOT / "scripts" / "workflow-capacity-plugin"), provider)
        settings["agents"] = {
            "capacity-reader": {
                "mode": "subagent", "steps": 8,
                "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
            },
        }
        sandbox = WorkflowSandbox(settings, artifacts)
        sandbox.await_plugin()
        owner = sandbox.api("POST", "/api/session", {
            "title": "Workflow capacity verification", "location": {"directory": str(sandbox.directory)},
        })["data"]["id"]

        # Two simultaneous runs contend for one owner-wide pool of eight slots.
        gate.clear()
        combined_started = time.monotonic()
        prefixes = ["CAP_OWNER_A_", "CAP_OWNER_B_"]
        for prefix in prefixes:
            for index in range(8):
                report(f"{prefix}{index:02d}", {"identity": f"{prefix}{index:02d}"}, wait=True)
        body = '''return await pipeline(args.items, item => agent(item.marker, {
          key: item.marker, agent: "capacity-reader"
        }));'''
        first = decoded(run_tool(owner, "workflows_start", {
            "key": "owner-a", "script": script("owner-a", body), "concurrency": 8, "maxAgents": 8,
            "args": {"items": [{"marker": f"CAP_OWNER_A_{index:02d}"} for index in range(8)]},
        }))
        eventually(lambda: gate.snapshot()["active"] == 8, timeout=60)
        second = decoded(run_tool(owner, "workflows_start", {
            "key": "owner-b", "script": script("owner-b", body), "concurrency": 8, "maxAgents": 8,
            "args": {"items": [{"marker": f"CAP_OWNER_B_{index:02d}"} for index in range(8)]},
        }))
        time.sleep(0.3)
        blocked = gate.snapshot()
        assert blocked == {"active": 8, "peak": 8}, blocked
        rss_at_eight = rss_bytes()
        gate.set()
        owner_runs = [settled(owner, first["id"]), settled(owner, second["id"])]
        owner_workers = [step["workerID"] for run in owner_runs for step in run["steps"]]
        assert len(owner_workers) == len(set(owner_workers)) == 16
        assert all(marker_requests(prefix) >= 8 for prefix in prefixes)
        metrics["scenarios"]["ownerPool"] = {
            "peakBlockedWorkers": blocked["peak"], "runs": 2, "nativeWorkerSessions": len(owner_workers),
            "uniqueWorkerSessions": len(set(owner_workers)), "rssBytesAtEight": rss_at_eight,
            "elapsedSeconds": round(time.monotonic() - combined_started, 3),
        }
        passed("two simultaneous workflows share the configured owner-wide pool and peak at eight native workers")

        # Sustained execution creates a real native session for every step.
        gate.clear()
        sustained_started = time.monotonic()
        sustained_prefix = "CAP_LONG_"
        for index in range(args.steps):
            marker = f"{sustained_prefix}{index:04d}"
            report(marker, {"identity": index}, wait=True)
        long_run = decoded(run_tool(owner, "workflows_start", {
            "key": f"long-{args.steps}", "script": script("sustained", body),
            "concurrency": 8, "maxAgents": args.steps,
            "args": {"items": [{"marker": f"{sustained_prefix}{index:04d}"} for index in range(args.steps)]},
        }))
        eventually(lambda: gate.snapshot()["active"] == 8, timeout=60)
        gate.set()
        long_result = settled(owner, long_run["id"])
        identities = [item["identity"] for item in long_result["result"]]
        worker_ids = [step["workerID"] for step in long_result["steps"]]
        assert identities == list(range(args.steps)), identities[:20]
        assert len(worker_ids) == len(set(worker_ids)) == args.steps
        assert all(step["status"] == "completed" for step in long_result["steps"])
        metrics["scenarios"]["sustained"] = {
            "steps": args.steps, "peakBlockedWorkers": gate.snapshot()["peak"],
            "nativeWorkerSessions": len(worker_ids), "uniqueWorkerSessions": len(set(worker_ids)),
            "providerRequests": marker_requests(sustained_prefix),
            "elapsedSeconds": round(time.monotonic() - sustained_started, 3),
        }
        passed(f"sustained {args.steps}-step execution preserves result order and unique native identities")

        # Parallel admission fails rather than racing beyond maxAgents.
        admission = start(owner, "admission-cap", '''return await parallel(Array.from({length: 9}, (_, i) =>
          () => agent("CAP_ADMISSION_" + i, {key: "item-" + i, agent: "capacity-reader"}))
        );''', concurrency=8, maxAgents=8)
        admission_run = settled(owner, admission["id"], expected="failed")
        assert len(admission_run["steps"]) <= 8
        assert "agent limit reached (8)" in admission_run["error"], admission_run["error"]
        metrics["scenarios"]["admission"] = {"admitted": len(admission_run["steps"]), "status": admission_run["status"]}
        passed("parallel admission fails at maxAgents without creating a ninth step")

        # Pause drains the active eight and prevents queued native starts.
        gate.clear()
        pause_prefix = "CAP_PAUSE_"
        for index in range(16):
            report(f"{pause_prefix}{index:02d}", {"identity": index}, wait=True)
        paused_start = decoded(run_tool(owner, "workflows_start", {
            "key": "pause-load", "script": script("pause-load", body), "concurrency": 8, "maxAgents": 16,
            "args": {"items": [{"marker": f"{pause_prefix}{index:02d}"} for index in range(16)]},
        }))
        eventually(lambda: gate.snapshot()["active"] == 8, timeout=60)
        pause_requested = time.monotonic()
        decoded(run_tool(owner, "workflows_control", {"runID": paused_start["id"], "action": "pause"}))
        gate.set()
        paused = settled(owner, paused_start["id"], expected="paused")
        pause_elapsed = time.monotonic() - pause_requested
        started_before_pause = initial_marker_requests(pause_prefix)
        assert started_before_pause == 8, started_before_pause
        decoded(run_tool(owner, "workflows_control", {"runID": paused_start["id"], "action": "stop"}))
        assert inspect(owner, paused_start["id"])["status"] == "stopped"
        metrics["scenarios"]["pause"] = {
            "queuedSteps": len(paused["steps"]) - started_before_pause,
            "nativeStarts": started_before_pause, "elapsedSeconds": round(pause_elapsed, 3),
        }
        passed("pause drains eight active workers without starting queued native work")

        # Stop interrupts eight blocked native requests and leaves no active sessions.
        gate.clear()
        stop_prefix = "CAP_STOP_"
        for index in range(8):
            report(f"{stop_prefix}{index:02d}", {"identity": index}, wait=True)
        stopped_start = decoded(run_tool(owner, "workflows_start", {
            "key": "stop-load", "script": script("stop-load", body), "concurrency": 8, "maxAgents": 8,
            "args": {"items": [{"marker": f"{stop_prefix}{index:02d}"} for index in range(8)]},
        }))
        eventually(lambda: gate.snapshot()["active"] == 8, timeout=60)
        stop_requested = time.monotonic()
        stopped = decoded(run_tool(owner, "workflows_control", {"runID": stopped_start["id"], "action": "stop"}))
        stop_elapsed = time.monotonic() - stop_requested
        assert stopped["status"] == "stopped", stopped
        gate.set()
        eventually(lambda: gate.snapshot()["active"] == 0, timeout=30)
        eventually(lambda: not sandbox.api("GET", "/api/session/active")["data"], timeout=30)
        metrics["scenarios"]["stop"] = {
            "interruptedWorkers": 8, "elapsedSeconds": round(stop_elapsed, 3),
            "providerBrokenPipes": provider.cancelled,
        }
        passed("stop settles an eight-worker load and cleans up every active native session")

        # Worker and run timers fire at the supported one-second minimum.
        gate.clear()
        report("CAP_TIMEOUT", {"identity": "timeout"}, wait=True)
        timeout_started = time.monotonic()
        timed = start(owner, "worker-timeout", '''return await agent("CAP_TIMEOUT", {
          key: "timeout", agent: "capacity-reader"
        });''', agentTimeoutMs=1000, timeoutMs=10000)
        timed_run = settled(owner, timed["id"], expected="failed")
        worker_timeout_elapsed = time.monotonic() - timeout_started
        assert "timed out after 1000ms" in timed_run["error"], timed_run["error"]
        gate.set()
        eventually(lambda: gate.snapshot()["active"] == 0, timeout=30)
        run_timeout_started = time.monotonic()
        run_timed = start(owner, "run-timeout", 'return await checkpoint("wait", {key: "wait"});', timeoutMs=1000)
        run_timed_result = settled(owner, run_timed["id"], expected="failed")
        run_timeout_elapsed = time.monotonic() - run_timeout_started
        assert "Workflow timeout exceeded" in run_timed_result["error"], run_timed_result["error"]
        metrics["scenarios"]["timeouts"] = {
            "workerConfiguredMs": 1000, "workerElapsedSeconds": round(worker_timeout_elapsed, 3),
            "runConfiguredMs": 1000, "runElapsedSeconds": round(run_timeout_elapsed, 3),
        }
        passed("worker and run timers enforce the supported one-second minimum under the deterministic provider")

        # The cumulative host-call formula is maxAgents * 8 + 100 (108 here).
        calls_ok = start(owner, "calls-108", 'for (let i = 0; i < 108; i++) await log("x"); return 108;', maxAgents=1)
        assert settled(owner, calls_ok["id"])["result"] == 108
        calls_bad = start(owner, "calls-109", 'for (let i = 0; i < 109; i++) await log("x"); return 109;', maxAgents=1)
        calls_failed = settled(owner, calls_bad["id"], expected="failed")
        assert "call limit exceeded (108)" in calls_failed["error"], calls_failed["error"]
        assert len(inspect(owner, calls_ok["id"])["logs"]) == 108
        metrics["scenarios"]["hostCalls"] = {"accepted": 108, "rejected": 109, "retainedLogs": 108}
        passed("the real runtime accepts 108 host calls and rejects the 109th when maxAgents is one")

        logs = start(owner, "logs-205", 'for (let i = 0; i < 205; i++) await log("log-" + i); return true;', maxAgents=20)
        logs_run = settled(owner, logs["id"])
        assert len(logs_run["logs"]) == 200
        assert logs_run["logs"][0]["text"] == "log-5" and logs_run["logs"][-1]["text"] == "log-204"
        metrics["scenarios"]["journalLogs"] = {"written": 205, "retained": 200, "firstRetained": "log-5"}
        passed("the live journal retains only the newest 200 bounded progress logs")

        active = sandbox.api("GET", "/api/session/active")["data"]
        assert not active, active
        all_worker_ids = owner_workers + worker_ids
        for worker_id in all_worker_ids:
            assert sandbox.api("GET", f"/api/session/{worker_id}")["data"]["id"] == worker_id
        metrics["cleanup"] = {"activeSessions": 0, "verifiedNativeSessions": len(all_worker_ids)}
        metrics["provider"] = {"requests": len(provider.requests), "cancelledWrites": provider.cancelled}
        assert source_hash(target) == verified_source, "Source changed during capacity verification"
        metrics["sourceHash"] = verified_source
        (artifacts / "evidence.json").write_text(json.dumps({"checks": checks, "metrics": metrics}, indent=2) + "\n")
    finally:
        gate.set()
        if sandbox:
            sandbox.stop()
        provider.close()

    print(json.dumps({"checks": checks, "metrics": metrics, "artifacts": str(artifacts)}, indent=2))


if __name__ == "__main__":
    main()
