import hashlib
import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sandbox import eventually


# Threads registers these administrative tools for Code Mode. A model reaches them only through
# the native `execute` tool at these catalog paths. threads_spawn, threads_send, threads_report,
# workflows_start, and workflows_result stay native, so read-only workers keep their report tools.
CODE_MODE_TOOLS = {
    "threads_list": "threads.list",
    "threads_interrupt": "threads.interrupt",
    "threads_hide": "threads.hide",
    "workflows_list": "workflows.list",
    "workflows_inspect": "workflows.inspect",
    "workflows_control": "workflows.control",
    "workflows_prune": "workflows.prune",
    "workflows_save": "workflows.save",
    "workflows_saved": "workflows.saved",
    "workflows_heartbeat_enroll": "workflows.heartbeat_enroll",
    "workflows_heartbeat_update": "workflows.heartbeat_update",
    "workflows_heartbeat_rebind": "workflows.heartbeat_rebind",
    "workflows_heartbeat_stop": "workflows.heartbeat_stop",
    "workflows_heartbeat_inspect": "workflows.heartbeat_inspect",
}
NATIVE_TOOLS = {"threads_spawn", "threads_send", "threads_report", "workflows_start", "workflows_result"}


def tool_call(name, arguments):
    """The fixture model's call for a Threads tool: native, or one Code Mode call inside `execute`."""
    path = CODE_MODE_TOOLS.get(name)
    if path is None:
        return {"name": name, "arguments": arguments}
    return {"name": "execute", "arguments": {"code": f"return await tools.{path}({json.dumps(arguments)});"}}


def exposed(name):
    return "execute" if name in CODE_MODE_TOOLS else name


def code_mode_result(name, part):
    """Present a finished `execute` part like the native part of the Threads tool it called.

    `execute` itself completes when the inner call fails and marks the failure in its metadata.
    A success must show exactly one completed call to the expected Code Mode path."""
    path = CODE_MODE_TOOLS.get(name)
    if path is None or part["state"]["status"] != "completed":
        return part
    metadata = part["state"].get("metadata") or {}
    calls = metadata.get("toolCalls") or []
    failed = metadata.get("error") is True or any(call.get("status") == "error" for call in calls)
    if not failed:
        assert [(call.get("tool"), call.get("status")) for call in calls] == [(path, "completed")], part
    return {**part, "state": {**part["state"], "status": "error" if failed else "completed"}}


def run_tool(sandbox, provider, session_id, name, arguments):
    """Have the fixture model call one Threads tool in `session_id`, wait for the session to go idle, and return the finished tool part."""
    def results():
        messages = sandbox.api("GET", f"/api/session/{session_id}/message?limit=100")["data"]
        return [part for message in messages if message["type"] == "assistant" for part in message["content"]
                if part["type"] == "tool" and part["name"] == exposed(name) and part["state"]["status"] in ["completed", "error"]]

    before = {part["id"] for part in results()}
    marker = f"FIXTURE_{uuid.uuid4().hex}"
    provider.responses[marker] = tool_call(name, arguments)
    sandbox.api("POST", f"/api/session/{session_id}/prompt", {"text": marker})
    output = eventually(lambda: next((part for part in results() if part["id"] not in before), None), timeout=60)
    eventually(lambda: session_id not in sandbox.api("GET", "/api/session/active")["data"], timeout=60)
    return code_mode_result(name, output)


def decoded(part):
    assert part["state"]["status"] == "completed", part
    return json.loads(part["state"]["content"][0]["text"])


def native_tools(request):
    return {tool["function"]["name"] for tool in request.get("tools", [])}


def code_mode_namespace(request, namespace, count=None):
    """Whether the request's Code Mode catalog lists `namespace`, with exactly `count` tools when given."""
    text = json.dumps(request.get("messages", []))
    tools = r"\d+" if count is None else str(count)
    return re.search(rf"- {re.escape(namespace)} \({tools} tools?[,)]", text) is not None


class Provider:
    def __init__(self):
        self.requests = []
        self.responses = {}
        self.failed_once = set()
        self.cancelled = 0
        self.release = threading.Event()
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                provider.requests.append(request)
                messages = request.get("messages", [])
                matches = [
                    (index, key, value)
                    for index, message in enumerate(messages)
                    if message.get("role") == "user"
                    for key, value in provider.responses.items()
                    if key in str(message.get("content", ""))
                ]
                position, marker, selected = matches[-1] if matches else (-1, None, None)
                tools = [message for message in messages[position + 1:] if message.get("role") == "tool"]
                if selected and (selected.get("error_always") or
                                 (selected.get("error_once_after_tool") and tools and marker not in provider.failed_once)):
                    provider.failed_once.add(marker)
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {"type": "invalid_request_error", "message":
                        "This model does not support assistant message prefill. The conversation must end with a user message."}}).encode())
                    return
                sequence = selected.get("sequence") if selected else None
                if sequence:
                    selected = sequence[len(tools)] if len(tools) < len(sequence) else None
                if selected and (sequence or not tools):
                    if selected.get("wait"):
                        provider.release.wait(90)
                    delta = {
                        "tool_calls": [{
                            "index": 0,
                            "id": f"call_fixture_{len(provider.requests)}",
                            "type": "function",
                            "function": {
                                "name": selected["name"],
                                "arguments": json.dumps(selected["arguments"]),
                            },
                        }],
                    }
                    finish = "tool_calls"
                else:
                    delta = {"content": "Fixture completed."}
                    finish = "stop"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunks = [
                    {"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                     "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}},
                ]
                try:
                    for chunk in chunks:
                        chunk.update({"id": "fixture", "object": "chat.completion.chunk", "model": "fixture"})
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    provider.cancelled += 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def config(plugin, provider):
    return {
        "plugins": [str(plugin)],
        "model": "fixture/fixture",
        "snapshots": False,
        "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
        "providers": {
            "fixture": {
                "env": ["FIXTURE_API_KEY"],
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {"baseURL": provider.url},
                "models": {
                    "fixture": {
                        "name": "Fixture",
                        "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                        "limit": {"context": 100000, "output": 4000},
                    },
                },
            },
        },
    }


def source_fingerprint(target):
    """One hash over the files OpenCode can load from the plugin package at `target`; missing files are skipped."""
    digest = hashlib.sha256()
    paths = [target / "index.ts", target / "tui.ts", target / "tui.js", target / "package.json", target / "bin" / "op-threads-heartbeat.mjs",
             *sorted((target / "src").glob("*.ts")), *sorted((target / "src").glob("*.tsx"))]
    for path in paths:
        if path.exists():
            digest.update(str(path.relative_to(target)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()
