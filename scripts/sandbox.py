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


def git_repository(directory, name="README.md", text="Native fixture\n"):
    """Make `directory` a Git repository on `main` whose one commit adds `name`."""
    subprocess.run(["git", "init", "-b", "main", str(directory)], check=True, capture_output=True)
    (directory / name).write_text(text)
    subprocess.run(["git", "add", name], cwd=directory, check=True)
    subprocess.run(["git", "-c", "user.name=Workflow fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"],
                   cwd=directory, check=True, capture_output=True)


class Sandbox:
    hostname = "127.0.0.1"

    def __init__(self, configuration, artifact_dir, temp_parent=None, repository=None):
        """`temp_parent` holds the sandbox root, by default OpenCode's temporary directory. With `repository`,
        the coordinator directory starts as a Git repository whose README.md contains that text."""
        self.binary = shutil.which("opencode")
        if temp_parent is None:
            temp_parent = subprocess.check_output([self.binary, "debug", "paths", "tmp"], text=True).strip()
        self.root = Path(tempfile.mkdtemp(prefix="op-threads-verify-", dir=temp_parent))
        self.artifacts = artifact_dir
        artifact_dir.mkdir(parents=True, exist_ok=True)
        self.directory = self.root / "coordinator"
        self.worker = self.root / "worker"
        self.directory.mkdir()
        self.worker.mkdir()
        if repository is not None:
            git_repository(self.directory, text=repository)
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
        ipv6 = ":" in self.hostname
        with socket.socket(socket.AF_INET6 if ipv6 else socket.AF_INET) as listener:
            listener.bind((self.hostname, 0))
            port = listener.getsockname()[1]
        self.url = f"http://[{self.hostname}]:{port}" if ipv6 else f"http://{self.hostname}:{port}"
        self.log = (self.artifacts / "server.log").open("ab")
        start = self.log.tell()
        self.process = subprocess.Popen(
            [self.binary, "serve", "--service", "--hostname", self.hostname, "--port", str(port)],
            cwd=self.directory, env=self.env, stdout=self.log, stderr=self.log,
        )

        def healthy():
            if self.process.poll() is not None:
                raise RuntimeError(f"Isolated server exited: {self.artifacts / 'server.log'}")
            if not self.password:
                registration = self.root / "state" / "opencode" / "service.json"
                if registration.exists():
                    info = json.loads(registration.read_text())
                    if info.get("pid") == self.process.pid:
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
        def active():
            plugins = self.api("GET", "/api/plugin", location=self.directory)
            (self.artifacts / "plugins.json").write_text(json.dumps(plugins, indent=2))
            return any(plugin["id"] == "op-threads" and plugin["state"]["status"] == "active"
                       for plugin in plugins["data"])
        return eventually(active)

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
            if method == "GET" and path == "/api/info" and error.code == 503:
                return {}
            raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from error


class IsolatedSandbox(Sandbox):
    """A sandbox for the heartbeat runner: project configuration is off and the coordinator is a Git repository."""

    def __init__(self, configuration, artifact_dir, temp_parent=None):
        super().__init__(configuration, artifact_dir, temp_parent, repository="heartbeat fixture\n")

    def start(self):
        self.env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
        super().start()


class Heartbeat:
    """Runs a package's heartbeat CLI and records each command in `commands.json`."""

    def __init__(self, target, artifacts):
        self.runner = target / "bin/op-threads-heartbeat.mjs"
        self.artifacts = artifacts
        self.commands = []
        self.config_file = None

    def configure(self, sandbox, host, label):
        """Write the runner configuration that `install` would write, without installing a LaunchAgent."""
        self.config_file = sandbox.root / "runner.json"
        self.config_file.write_text(json.dumps({
            "protocol": 1, "serviceFile": str(sandbox.root / "state/opencode/service.json"), "hostDirectory": str(host),
            "node": shutil.which("node"), "runner": str(self.runner), "intervalMs": 60_000, "label": label,
            "launchAgentsDirectory": str(sandbox.root / "launchagents"),
        }))

    def command(self, args):
        result = subprocess.run(args, cwd=Path(__file__).resolve().parent.parent, text=True, capture_output=True, timeout=90)
        self.commands.append({"command": args, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        (self.artifacts / "commands.json").write_text(json.dumps(self.commands, indent=2))
        return result

    def cli(self, *args, success=True):
        result = self.command(["node", str(self.runner), *args, "--config", str(self.config_file)])
        if success:
            assert result.returncode == 0, self.commands[-1]
            return json.loads(result.stdout)
        assert result.returncode != 0, self.commands[-1]
        return result


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

    def drain(self, quiet=0.03, timeout=10):
        # A text match may occur halfway through a frame, before its hit grid is ready.
        last = time.monotonic()
        def quiet_frame(_):
            nonlocal last
            if select.select([self.master], [], [], 0)[0]:
                last = time.monotonic()
                return False
            return time.monotonic() - last >= quiet
        self.wait_for_match(quiet_frame, "drained terminal frame", timeout, False)

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
