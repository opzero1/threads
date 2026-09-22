import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider:
    def __init__(self):
        self.requests = []
        self.responses = {}
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
                    (index, value)
                    for index, message in enumerate(messages)
                    if message.get("role") == "user"
                    for key, value in provider.responses.items()
                    if key in str(message.get("content", ""))
                ]
                position, selected = matches[-1] if matches else (-1, None)
                tools = [message for message in messages[position + 1:] if message.get("role") == "tool"]
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
