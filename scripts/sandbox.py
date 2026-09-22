import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def eventually(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError("Expected live state was not observed")


class Sandbox:
    def __init__(self, configuration, artifact_dir):
        self.binary = shutil.which("opencode")
        tmp = subprocess.check_output([self.binary, "debug", "paths", "tmp"], text=True).strip()
        self.root = Path(tempfile.mkdtemp(prefix="op-threads-verify-", dir=tmp))
        self.artifacts = artifact_dir
        artifact_dir.mkdir(parents=True, exist_ok=True)
        self.directory = self.root / "coordinator"
        self.worker = self.root / "worker"
        self.directory.mkdir()
        self.worker.mkdir()
        configuration_dir = self.root / "config" / "opencode"
        configuration_dir.mkdir(parents=True)
        (configuration_dir / "opencode.json").write_text(json.dumps(configuration))
        (configuration_dir / "cli.json").write_text(json.dumps({
            "plugins": [{"package": str(Path(__file__).resolve().parent / "tui-probe"), "options": {"path": str(artifact_dir.resolve() / "tabs.json")}}],
            "tabs": {"layout": "vertical", "indicators": "status"},
            "attention": {"enabled": False},
            "session": {"sidebar": "hide"},
            "animations": True,
        }))
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "FIXTURE_API_KEY": "local-fixture-only",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        }
        self.process = None
        self.log = None
        self.password = None
        try:
            self.start()
        except BaseException:
            self.stop()
            raise

    def start(self):
        self.password = None
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.log = (self.artifacts / "server.log").open("ab")
        start = self.log.tell()
        self.process = subprocess.Popen(
            [self.binary, "serve", "--service", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=self.directory, env=self.env, stdout=self.log, stderr=self.log,
        )

        def healthy():
            if self.process.poll() is not None:
                raise RuntimeError(f"Isolated server exited: {self.artifacts / 'server.log'}")
            if not self.password:
                registration = self.root / "state" / "opencode" / "service.json"
                if registration.exists():
                    info = json.loads(registration.read_text())
                    if info.get("url", "").rstrip("/") == self.url.rstrip("/"):
                        self.password = info.get("password")
                content = (self.artifacts / "server.log").read_bytes()[start:].decode()
                match = re.search(r"server password (\S+)", content)
                if not match and not self.password:
                    return False
                if match:
                    self.password = match.group(1)
            try:
                return self.api("GET", "/api/info").get("version")
            except (URLError, TimeoutError):
                return False

        eventually(healthy, timeout=60)

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.log:
            self.log.close()
            path = self.artifacts / "server.log"
            path.write_text(re.sub(r"server password \S+", "server password [redacted]", path.read_text()))

    def await_plugin(self):
        return eventually(lambda: any(
            plugin["id"] == "op-threads" and plugin["state"]["status"] == "active"
            for plugin in self.api("GET", "/api/plugin", location=self.directory)["data"]
        ))

    def api(self, method, path, body=None, location=None):
        if location:
            path += ("&" if "?" in path else "?") + urlencode({"location[directory]": str(location)})
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.password:
            credentials = base64.b64encode(f"opencode:{self.password}".encode()).decode()
            headers["Authorization"] = f"Basic {credentials}"
        request = Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urlopen(request, timeout=45) as response:
                content = response.read()
                return json.loads(content) if content else None
        except HTTPError as error:
            raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from error


class Terminal:
    def __init__(self, sandbox, session_id):
        import pyte

        self.output = bytearray()
        self.screen = pyte.Screen(160, 48)
        self.stream = pyte.ByteStream(self.screen)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))

        def attach():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [sandbox.binary, str(sandbox.directory), "--session", session_id],
            stdin=slave, stdout=slave, stderr=slave, env=sandbox.env, preexec_fn=attach,
        )
        os.close(slave)

    def text(self):
        decoded = self.output.decode("utf-8", errors="replace")
        return re.sub(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])", "", decoded)

    def wait_for(self, text, timeout=40, left=False):
        self.wait_for_match(lambda display: text in display, repr(text), timeout, left)

    def wait_for_order(self, titles, timeout=40):
        pattern = re.compile(".*".join(map(re.escape, titles)), re.S)
        self.wait_for_match(lambda display: pattern.search(display), str(titles), timeout, True)

    def wait_for_match(self, matches, description, timeout, left):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            display = "\n".join(line[:42] if left else line for line in self.screen.display)
            if matches(display):
                return
            if self.process.poll() is not None:
                raise RuntimeError(f"TUI exited before displaying {description}")
            if not select.select([self.master], [], [], 0.1)[0]:
                continue
            chunk = os.read(self.master, 65536)
            self.output.extend(chunk)
            self.stream.feed(chunk)
            for query, response in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c")]:
                if query in chunk:
                    os.write(self.master, response)
        raise TimeoutError(f"TUI did not display {description}")

    def close(self, path):
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        path.write_text(self.text())
        path.with_suffix(".screen.txt").write_text("\n".join(self.screen.display))
