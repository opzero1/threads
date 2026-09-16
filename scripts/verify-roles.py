import json
from pathlib import Path
import sys
import uuid

from fixture import Provider, config
from sandbox import Sandbox, eventually


root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
artifacts = root / ".audit" / ("roles" if target == root else "roles-package")
provider = Provider()
sandbox = None
checks = []


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

    def result():
        return next((part for part in results() if part["id"] not in before), None)

    output = eventually(result, timeout=60)
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"])
    return output


try:
    settings = config(target, provider)
    settings["providers"]["fixture"]["models"]["role"] = {
        **settings["providers"]["fixture"]["models"]["fixture"], "name": "Role model",
        "variants": [{"id": "deep", "body": {"role_variant_probe": "deep"}}],
    }
    settings["agents"] = {
        "fixture-core": {
            "mode": "subagent", "model": "fixture/role#deep", "steps": 12,
            "system": "FIXTURE_CORE_SYSTEM. Coordinate the assigned work and return its evidence.",
            "permissions": [{"action": "subagent", "resource": "*", "effect": "allow"}],
        },
        "fixture-reader": {
            "mode": "subagent", "steps": 12,
            "system": "FIXTURE_READER_SYSTEM. Read only and return findings to your coordinator.",
            "permissions": [
                {"action": "*", "resource": "*", "effect": "deny"},
                {"action": "read", "resource": "*", "effect": "allow"},
                {"action": "glob", "resource": "*", "effect": "allow"},
            ],
        },
        "fixture-engineer": {
            "mode": "subagent", "system": "FIXTURE_ENGINEER_SYSTEM. Implement directly without delegation.",
            "permissions": [{"action": "subagent", "resource": "*", "effect": "deny"}],
        },
    }
    sandbox = Sandbox(settings, artifacts)
    (sandbox.worker / "opencode.json").write_text(json.dumps({
        "agents": {"fixture-core": {"system": "FIXTURE_DESTINATION_SYSTEM. Coordinate the assigned work."}},
    }))
    sandbox.api("POST", "/api/plugin/await-activation", location=sandbox.directory)
    coordinator = sandbox.api("POST", "/api/session", {
        "title": "Role fixture coordinator", "location": {"directory": str(sandbox.directory)},
        "permissions": [{"action": "shell", "resource": "*", "effect": "deny"}],
    })["data"]
    request = {
        "key": "role-core", "title": "Role fixture worker", "directory": str(sandbox.worker),
        "task": "ROLE_CORE_DONE", "agent": "fixture-core",
    }
    provider.responses["ROLE_CORE_DONE"] = {
        "name": "threads_report",
        "arguments": {"verdict": "PASS", "summary": "Role fixture completed", "evidence": ["native session"]},
    }
    spawned = run_tool(coordinator["id"], "threads_spawn", request)
    assert spawned["state"]["status"] == "completed", spawned
    selected_view = json.loads(spawned["state"]["content"][0]["text"])
    workers = sandbox.api("POST", "/api/rpc/threads/snapshot", {
        "input": {"coordinatorIDs": [coordinator["id"]]},
    }, location=sandbox.directory)["output"]["workers"]
    assert len(workers) == 1, workers
    worker_id = workers[0]["workerID"]
    worker = sandbox.api("GET", f"/api/session/{worker_id}")["data"]
    assert not worker.get("parentID"), worker
    assert worker["agent"] == "fixture-core", worker
    assert worker["model"] == {"providerID": "fixture", "id": "role", "variant": "deep"}, worker
    assert selected_view["agent"] == worker["agent"] and selected_view["model"] == worker["model"], selected_view
    eventually(lambda: any(
        request.get("model") == "role" and request.get("role_variant_probe") == "deep"
        and "FIXTURE_DESTINATION_SYSTEM" in json.dumps(request.get("messages", []))
        for request in provider.requests
    ))
    passed("an explicit agent creates a top-level worker with that role's model, variant, and system prompt")
    child = run_tool(worker_id, "subagent", {
        "agent": "fixture-reader", "description": "Read the delegated fixture", "prompt": "Return a short finding without tools.",
    })
    assert child["state"]["status"] == "completed", child
    children = sandbox.api("GET", f"/api/session?parentID={worker_id}&limit=100")["data"]
    assert len(children) == 1 and children[0]["agent"] == "fixture-reader", children
    assert "Fixture completed." in json.dumps(child["state"]["content"]), child
    passed("a managed core-role worker can run a named native reader and receive its findings")
    child_report = run_tool(children[0]["id"], "threads_report", {
        "verdict": "PASS", "summary": "Not a managed owner", "evidence": [],
    })
    assert child_report["state"]["status"] == "error", child_report
    nested = run_tool(worker_id, "threads_spawn", {**request, "key": "forbidden-grandchild"})
    assert nested["state"]["status"] == "error" and "cannot spawn managed workers" in json.dumps(nested["state"]), nested
    passed("native children cannot report as managed owners and core workers cannot spawn managed grandchildren")

    forbidden = sandbox.worker / "forbidden-parent-policy-output"
    denied = run_tool(worker_id, "shell", {"command": f"touch '{forbidden}'"})
    assert denied["state"]["status"] == "error" and not forbidden.exists(), denied
    passed("a selected role cannot bypass the coordinator's shell restriction")

    broad = sandbox.api("POST", "/api/session", {
        "title": "Broadly permitted coordinator", "location": {"directory": str(sandbox.directory)},
        "permissions": [
            {"action": "*", "resource": "*", "effect": "allow"},
            {"action": "shell", "resource": "*", "effect": "ask"},
        ],
    })["data"]
    reader = run_tool(broad["id"], "threads_spawn", {
        **request, "key": "reader", "agent": "fixture-reader", "task": "Inspect the assigned directory.",
    })
    assert reader["state"]["status"] == "completed", reader
    reader_id = json.loads(reader["state"]["content"][0]["text"])["workerID"]
    readable = sandbox.worker / "reader-evidence.txt"
    readable.write_text("READONLY_ROLE_CAN_READ\n")
    read = run_tool(reader_id, "read", {"path": str(readable)})
    assert read["state"]["status"] == "completed" and "READONLY_ROLE_CAN_READ" in json.dumps(read["state"]), read
    reader_session = sandbox.api("GET", f"/api/session/{reader_id}")["data"]
    assert reader_session["model"] == {"providerID": "fixture", "id": "fixture", "variant": "default"}, reader_session
    passed("a model-less reader inherits the calling model and retains its allowed read operation")
    for name, arguments in [
        ("shell", {"command": f"touch '{forbidden}'"}),
        ("patch", {"patchText": f"*** Begin Patch\n*** Add File: {forbidden}\n+forbidden\n*** End Patch"}),
        ("subagent", {"agent": "fixture-core", "description": "Forbidden child", "prompt": "Done"}),
    ]:
        blocked = run_tool(reader_id, name, arguments)
        assert blocked["state"]["status"] == "error" and not forbidden.exists(), blocked
    passed("a coordinator's allow or ask does not erase a reader's shell, edit, or delegation restrictions")
    reported = run_tool(reader_id, "threads_report", {
        "verdict": "PASS", "summary": "Readonly role finished", "evidence": ["No forbidden operations executed"],
    })
    assert reported["state"]["status"] == "completed", reported
    passed("a deny-all reader can submit its own ownership-checked managed report")

    for agent, effect in [("fixture-reader", "deny"), ("fixture-core", "ask")]:
        restricted = sandbox.api("POST", "/api/session", {
            "title": "Named target restriction", "location": {"directory": str(sandbox.directory)},
            "permissions": [{"action": "subagent", "resource": agent, "effect": effect}],
        })["data"]
        blocked = run_tool(restricted["id"], "threads_spawn", {**request, "agent": agent})
        assert blocked["state"]["status"] == "error", blocked
        assert agent in json.dumps(blocked["state"]), blocked
        inventory = sandbox.api("POST", "/api/rpc/threads/snapshot", {
            "input": {"coordinatorIDs": [restricted["id"]]},
        }, location=sandbox.directory)["output"]["workers"]
        assert not inventory, inventory
    passed("named-target deny and ask cannot be bypassed through the generic spawn tool")

    conflict = run_tool(coordinator["id"], "threads_spawn", {**request, "agent": "fixture-reader"})
    assert conflict["state"]["status"] == "error" and "different request" in json.dumps(conflict["state"]), conflict
    passed("changing the agent under an existing spawn key conflicts")
    initial_ids = [message["id"] for message in messages(worker_id) if message["type"] == "user"]
    sandbox.api("POST", f"/api/session/{coordinator['id']}/model", {
        "model": {"providerID": "fixture", "id": "role", "variant": "deep"},
    })
    retried = run_tool(coordinator["id"], "threads_spawn", request)
    assert retried["state"]["status"] == "completed", retried
    assert json.loads(retried["state"]["content"][0]["text"])["workerID"] == worker_id, retried
    assert [message["id"] for message in messages(worker_id) if message["type"] == "user"] == initial_ids
    passed("an identical role request reuses the original worker without replaying its prompt")
    engineer = run_tool(coordinator["id"], "threads_spawn", {
        **request, "key": "engineer", "agent": "fixture-engineer", "task": "Implement the fixture directly.",
    })
    assert engineer["state"]["status"] == "completed", engineer
    engineer_view = json.loads(engineer["state"]["content"][0]["text"])
    assert engineer_view["model"] == {"providerID": "fixture", "id": "role", "variant": "deep"}, engineer_view
    leaf = run_tool(engineer_view["workerID"], "subagent", {
        "agent": "fixture-reader", "description": "Forbidden engineer child", "prompt": "Done",
    })
    assert leaf["state"]["status"] == "error", leaf
    passed("a model-less engineer inherits the calling variant and keeps its no-delegation restriction")

    (sandbox.worker / "opencode.json").write_text(json.dumps({
        "agents": {"fixture-core": {"disabled": True}},
    }))
    sandbox.stop()
    sandbox.start()
    sandbox.api("POST", "/api/plugin/await-activation", location=sandbox.directory)
    restored = run_tool(coordinator["id"], "threads_spawn", request)
    assert restored["state"]["status"] == "completed", restored
    restored_view = json.loads(restored["state"]["content"][0]["text"])
    assert restored_view["workerID"] == worker_id and restored_view["model"] == worker["model"], restored_view
    assert [message["id"] for message in messages(worker_id) if message["type"] == "user"] == initial_ids
    passed("a restart and removed profile do not reselect or replay an already admitted worker")

    rejected = run_tool(coordinator["id"], "threads_spawn", {**request, "key": "missing-profile"})
    assert rejected["state"]["status"] == "error" and "Agent not found" in json.dumps(rejected["state"]), rejected
    inventory = sandbox.api("POST", "/api/rpc/threads/snapshot", {
        "input": {"coordinatorIDs": [coordinator["id"]]},
    }, location=sandbox.directory)["output"]["workers"]
    pending = next(view for view in inventory if view["key"] == "missing-profile")
    assert not any(message["type"] in ["user", "assistant"] for message in messages(pending["workerID"]))
    passed("an unavailable profile rejects initial admission before any task or model execution")

    (sandbox.worker / "opencode.json").write_text(json.dumps({
        "agents": {"fixture-core": {"system": "FIXTURE_RECOVERED_SYSTEM"}},
    }))
    sandbox.stop()
    sandbox.start()
    sandbox.api("POST", "/api/plugin/await-activation", location=sandbox.directory)
    premature = run_tool(coordinator["id"], "threads_send", {
        "workerID": pending["workerID"], "key": "before-initialization", "text": "Start the task now.",
    })
    assert premature["state"]["status"] == "error" and "initial" in json.dumps(premature["state"]), premature
    assert not any(message["type"] in ["user", "assistant", "synthetic"] for message in messages(pending["workerID"]))
    passed("managed follow-ups cannot execute a worker whose initial role selection failed")
    try:
        sandbox.api("POST", f"/api/session/{pending['workerID']}/prompt", {"text": "Start through a direct prompt."})
    except RuntimeError as error:
        assert ": 500" in str(error), error
    else:
        raise AssertionError("A direct prompt bypassed initial role selection")
    assert not any(message["type"] in ["user", "assistant"] for message in messages(pending["workerID"]))
    passed("a direct user prompt cannot bypass pending role initialization")
    sandbox.api("PUT", f"/api/session/{coordinator['id']}/permission/rules", {"permissions": [
        {"action": "subagent", "resource": "fixture-core", "effect": "deny"},
    ]})
    revoked = run_tool(coordinator["id"], "threads_spawn", {**request, "key": "missing-profile"})
    assert revoked["state"]["status"] == "error" and "subagent allow" in json.dumps(revoked["state"]), revoked
    assert not any(message["type"] in ["user", "assistant"] for message in messages(pending["workerID"]))
    accepted_retry = run_tool(coordinator["id"], "threads_spawn", request)
    assert accepted_retry["state"]["status"] == "completed", accepted_retry
    passed("revoked role permission blocks first-admission recovery while an admitted retry still converges")
    sandbox.api("PUT", f"/api/session/{coordinator['id']}/permission/rules", {"permissions": [
        {"action": "shell", "resource": "*", "effect": "deny"},
    ]})
    recovered = run_tool(coordinator["id"], "threads_spawn", {**request, "key": "missing-profile"})
    assert recovered["state"]["status"] == "completed", recovered
    recovered_view = json.loads(recovered["state"]["content"][0]["text"])
    assert recovered_view["workerID"] == pending["workerID"] and recovered_view["model"] == worker["model"], recovered_view
    eventually(lambda: any(message["type"] == "assistant" for message in messages(pending["workerID"])))
    assert len([message for message in messages(pending["workerID"]) if message["type"] == "user"]) == 1
    passed("fixing a profile and retrying recovers its indexed worker with one initial prompt")
finally:
    if sandbox:
        sandbox.stop()
    provider.close()
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "results.json").write_text(json.dumps({"checks": checks, "count": len(checks)}, indent=2) + "\n")
    (artifacts / "provider-requests.json").write_text(json.dumps(provider.requests, indent=2) + "\n")
