"""Interrupting a worker must stop the follow-ups queued behind its current run.

OpenCode 2.1 keeps a queued follow-up in the worker's inbox when the run ahead of it is
interrupted, and any later wake promotes it. These checks run an isolated server with the
deterministic fixture model and confirm that no coordinator turn wakes a stopped worker, that
the interrupt result names each held follow-up, and that a later explicit send resumes them."""

import json
from pathlib import Path
import sys
import time

import fixture
from fixture import Provider, config, decoded
from sandbox import Sandbox, eventually


root = Path(__file__).resolve().parent.parent
arguments = sys.argv[1:]
scenario = "all"
if "--scenario" in arguments:
    index = arguments.index("--scenario")
    scenario = arguments[index + 1]
    del arguments[index:index + 2]
assert scenario in {"all", "threads", "native"}, scenario
target = Path(arguments[0]).resolve() if arguments else root
artifacts = root / ".audit" / f"interrupt-followups-{scenario}"
provider = Provider()
sandbox = None
checks = []
evidence = {}


def passed(label):
    checks.append(label)
    print(f"PASS: {label}", flush=True)


def messages(session_id):
    return sandbox.api("GET", f"/api/session/{session_id}/message?limit=200")["data"]


def inbox(session_id):
    return sandbox.api("GET", f"/api/session/{session_id}/inbox")["data"]


def active():
    return sandbox.api("GET", "/api/session/active")["data"]


def run_tool(session_id, name, arguments):
    return fixture.run_tool(sandbox, provider, session_id, name, arguments)


def saw(marker):
    """Whether any model request so far carried `marker` as input. A coordinator's requests carry
    it only inside its own tool-call arguments, which are assistant messages."""
    return any(message.get("role") == "user" and marker in json.dumps(message.get("content", ""))
               for request in provider.requests for message in request.get("messages", []))


def promoted(session_id, text):
    return any(text in json.dumps(message) for message in messages(session_id) if message["type"] == "synthetic")


def quiet(seconds, check):
    """Keep checking that `check` stays false for `seconds`."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        assert not check(), "unexpected live state"
        time.sleep(0.2)


def busy_worker(coordinator_id, key):
    marker = f"FIXTURE_BUSY_{key.upper().replace('-', '_')}"
    provider.responses[marker] = {"name": "threads_report", "wait": True,
                                  "arguments": {"verdict": "PASS", "summary": "Must not finish", "evidence": []}}
    spawned = run_tool(coordinator_id, "threads_spawn", {
        "key": key, "title": f"Interrupt fixture {key}", "directory": str(sandbox.worker), "task": marker,
    })
    worker_id = decoded(spawned)["workerID"]
    eventually(lambda: worker_id in active(), timeout=60)
    return worker_id


def interrupt_holds_followups(coordinator_id):
    """threads_interrupt holds a follow-up queued behind the running turn."""
    worker_id = busy_worker(coordinator_id, "held")
    queued_text = "FIXTURE_QUEUED_FOLLOWUP: this must not run after the interrupt."
    sent = decoded(run_tool(coordinator_id, "threads_send", {"workerID": worker_id, "key": "queued", "text": queued_text}))
    assert any(item["id"] == sent["messageID"] for item in inbox(worker_id)), inbox(worker_id)
    assert not promoted(worker_id, queued_text)
    passed("a follow-up sent to a busy worker waits in the native inbox")

    stopped = decoded(run_tool(coordinator_id, "threads_interrupt", {"workerID": worker_id}))
    evidence["interrupt"] = stopped
    eventually(lambda: worker_id not in active(), timeout=30)
    for _ in range(2):
        listed = run_tool(coordinator_id, "threads_list", {})
        assert listed["state"]["status"] == "completed", listed
    try:
        quiet(5, lambda: worker_id in active() or promoted(worker_id, queued_text) or saw("FIXTURE_QUEUED_FOLLOWUP"))
    finally:
        evidence["after_interrupt"] = {"active": worker_id in active(), "inbox": inbox(worker_id),
                                       "promoted": promoted(worker_id, queued_text), "modelSaw": saw("FIXTURE_QUEUED_FOLLOWUP")}
    passed("later coordinator turns and listing do not wake the interrupted worker or run its held follow-up")
    assert stopped.get("heldFollowups") == [sent["messageID"]], stopped
    passed("threads_interrupt names the follow-up it held")

    provider.release.set()
    resumed_text = "FIXTURE_RESUME_FOLLOWUP: continue now."
    resumed = decoded(run_tool(coordinator_id, "threads_send", {"workerID": worker_id, "key": "resume", "text": resumed_text}))
    evidence["resume"] = resumed
    assert resumed.get("resumedFollowups") == [sent["messageID"]], resumed
    eventually(lambda: promoted(worker_id, queued_text) and promoted(worker_id, resumed_text), timeout=60)
    eventually(lambda: worker_id not in active(), timeout=60)
    run_tool(coordinator_id, "threads_list", {})
    notices = lambda: [message for message in messages(coordinator_id) if message["type"] == "synthetic"
                       and "follow-up" in message.get("text", "") and "native execution" in message.get("text", "")]
    eventually(lambda: {sent["messageID"], resumed["messageID"]} <= {
        message.get("metadata", {}).get("opThreadsFollowup", {}).get("messageID") for message in notices()}, timeout=60)
    passed("a later explicit send resumes the held follow-up and both completions reach the coordinator")
    provider.release.clear()


def native_interrupt_stays_stopped(coordinator_id):
    """A native interrupt from the worker's own tab is not overridden by a coordinator turn."""
    native_id = busy_worker(coordinator_id, "native")
    native_text = "FIXTURE_NATIVE_QUEUED: this must not run after a native interrupt."
    queued = decoded(run_tool(coordinator_id, "threads_send", {"workerID": native_id, "key": "native-queued", "text": native_text}))
    assert any(item["id"] == queued["messageID"] for item in inbox(native_id)), inbox(native_id)
    sandbox.api("POST", f"/api/session/{native_id}/interrupt")
    eventually(lambda: native_id not in active(), timeout=30)
    for _ in range(2):
        run_tool(coordinator_id, "threads_list", {})
    try:
        quiet(5, lambda: native_id in active() or promoted(native_id, native_text) or saw("FIXTURE_NATIVE_QUEUED"))
    finally:
        evidence["after_native_interrupt"] = {"active": native_id in active(), "inbox": inbox(native_id),
                                              "promoted": promoted(native_id, native_text), "modelSaw": saw("FIXTURE_NATIVE_QUEUED")}
    passed("a native interrupt is not undone by the coordinator's follow-up recovery")


try:
    sandbox = Sandbox(config(target, provider), artifacts)
    sandbox.await_plugin()
    coordinator_id = sandbox.api("POST", "/api/session", {
        "title": "Interrupt coordinator", "location": {"directory": str(sandbox.directory)},
    })["data"]["id"]

    if scenario in {"all", "threads"}:
        interrupt_holds_followups(coordinator_id)
    if scenario in {"all", "native"}:
        native_interrupt_stays_stopped(coordinator_id)
finally:
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks), "evidence": evidence}, indent=2) + "\n")
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2) + "\n")
