"""Prove the built desktop backend listens only on its private Unix socket (Linux and macOS)."""

import argparse
import fcntl
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

from built_backend_lifecycle import ROOT, STARTUP_SECONDS, STOP_SECONDS, group_absent, health, inherited_lock, require, write_json

WINDOW_SECONDS = 4
POLL_SECONDS = .1
RUN_TOKEN = "PP_LISTENER_PROOF_RUN"

# Each control is preloaded into the built backend with --import.
CONTROLS = {
    "child_listener": """
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0, '127.0.0.1')"], { stdio: "ignore" }).unref();
""",
    "detached_grandchild_listener": """
import { spawnSync } from "node:child_process";
const grandchild = "require('node:net').createServer().listen(0, '127.0.0.1')";
spawnSync(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}],
  { detached: true, stdio: "ignore" }).unref()`]);
""",
    "late_backend_listener": """
import { existsSync } from "node:fs";
import { createServer } from "node:net";
const waiting = setInterval(() => {
  if (!existsSync(process.env.PP_LISTENER_CONTROL_SOCKET)) return;
  clearInterval(waiting);
  setTimeout(() => createServer().listen(0, "127.0.0.1").unref(), 1000).unref();
}, 50);
waiting.unref();
""",
}


class ListenerFound(AssertionError):
    def __init__(self, found):
        self.found = found
        outside = [listener for listener in found if not listener["in_backend_group"]]
        hint = f"; not in the backend's process group, check its args in case it is unrelated: {outside}" if outside else ""
        super().__init__(f"network listener found: {found}{hint}")


def lsof(*selection):
    result = subprocess.run(["lsof", "-w", "-nP", "-a", "-u", str(os.getuid()), *selection, "-F", "pcPn"],
                            capture_output=True, text=True)
    require(result.returncode in (0, 1) and not result.stderr, f"lsof failed: {result.returncode} {result.stderr}")
    require(result.returncode == 0 or not result.stdout, f"lsof exit 1 with output: {result.stdout}")
    return result.stdout.splitlines()


def user_listeners():
    found = set()
    for line in lsof("-iTCP", "-sTCP:LISTEN") + lsof("-iUDP"):
        field, value = line[0], line[1:]
        if field == "p":
            pid = int(value)
        elif field == "c":
            command = value
        elif field == "P":
            protocol = value
        elif field == "n":
            found.add((pid, command, protocol, value))
    return found


class Watch:
    """Fails as soon as a user-owned TCP listener or UDP socket appears that was absent before launch."""

    def __init__(self):
        self.baseline = user_listeners()
        self.backend = None
        self.polls = 0

    def poll(self):
        self.polls += 1
        new = user_listeners() - self.baseline
        if new:
            raise ListenerFound([self.describe(*listener) for listener in sorted(new)])

    def describe(self, pid, command, protocol, name):
        row = subprocess.run(["ps", "-ww", "-o", "ppid=,pgid=,args=", "-p", str(pid)],
                             capture_output=True, text=True).stdout.split(None, 2)
        lineage = {"ppid": int(row[0]), "pgid": int(row[1]), "args": row[2].strip()} if len(row) == 3 else {}
        return {"pid": pid, "command": command, "protocol": protocol, "name": name, **lineage,
                "in_backend_group": self.backend in (pid, lineage.get("pgid"))}


def token_carriers(token):
    marker = f"{RUN_TOKEN}={token}"
    if sys.platform == "linux":
        carriers = []
        for entry in Path("/proc").iterdir():
            try:
                if entry.name.isdigit() and marker.encode() in (entry / "environ").read_bytes().split(b"\0"):
                    carriers.append(int(entry.name))
            except OSError:
                pass
        return carriers
    rows = subprocess.check_output(["ps", "-wwE", "-U", str(os.getuid()), "-o", "pid=,command="], text=True)
    return [int(row.split(None, 1)[0]) for row in rows.splitlines() if marker in row.split()]


def kill_token_carriers(token):
    killed = token_carriers(token)
    for pid in killed:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while token_carriers(token):
        require(time.monotonic() < deadline, f"processes from this run survived SIGKILL: {token_carriers(token)}")
        time.sleep(.05)
    return killed


def pid_gone(pid):
    # A killed process reparented to init can stay a zombie briefly; a zombie holds no sockets.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return not state or state.startswith("Z")


def signed_get(socket_path, generation, key, target):
    assertion = {"version": 1, "generation": generation, "tenant": "default", "actor": "desktop-owner",
                 "method": "GET", "target": target, "issued_at": int(time.time() * 1000)}
    encoded = json.dumps(assertion, separators=(",", ":")).encode().hex()
    signature = hmac.new(bytes.fromhex(key), encoded.encode(), hashlib.sha256).hexdigest()
    connection = http.client.HTTPConnection("desktop-compat", timeout=1)
    connection.sock = socket.socket(socket.AF_UNIX)
    connection.sock.settimeout(1)
    try:
        connection.sock.connect(str(socket_path))
        connection.request("GET", target, headers={"x-pp-principal": encoded, "x-pp-signature": signature})
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


def assert_private_socket(socket_path):
    runtime = socket_path.parent.lstat()
    sock = socket_path.lstat()
    observed = {"socket": str(socket_path), "socket_mode": oct(stat.S_IMODE(sock.st_mode)),
                "socket_is_socket": stat.S_ISSOCK(sock.st_mode), "socket_uid": sock.st_uid,
                "runtime_dir_mode": oct(stat.S_IMODE(runtime.st_mode)),
                "runtime_dir_is_dir": stat.S_ISDIR(runtime.st_mode), "runtime_dir_uid": runtime.st_uid}
    require(observed["socket_is_socket"] and observed["socket_mode"] == "0o600" and sock.st_uid == os.getuid(),
            f"socket is not a private user socket: {observed}")
    require(observed["runtime_dir_is_dir"] and observed["runtime_dir_mode"] == "0o700" and runtime.st_uid == os.getuid(),
            f"runtime directory is not private: {observed}")
    return observed


def run_backend(node, evidence, control=None):
    evidence.mkdir()
    data = evidence / "data"
    data.mkdir(mode=0o700)
    token = secrets.token_hex(16)
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if name in os.environ}
    env.update(PP_STORAGE_CORE_LOCK="1", PRINT_PARTNER_UPDATE_CHECK="0", AI_ENABLED="0", HOST="127.0.0.1",
               DEPLOY_MODE="self-host", **{RUN_TOKEN: token})
    # A short temp path keeps the socket under the 104-byte macOS limit.
    runtime = Path(tempfile.mkdtemp(prefix="pp-listen-")).resolve()
    socket_path = runtime / "backend.sock"
    generation, key = secrets.token_hex(16), secrets.token_hex(32)
    preload = []
    if control:
        script = evidence / f"{control}.mjs"
        script.write_text(CONTROLS[control])
        preload = ["--import", script.as_uri()]
        env["PP_LISTENER_CONTROL_SOCKET"] = str(socket_path)
    # The control loads before the package-boundary hook, which would reject a script outside the repository.
    command = [str(node), "--no-global-search-paths", *preload,
               "--import", str(ROOT / "web/apps/server/dist/current/desktop-resolution.js"),
               str(ROOT / "web/apps/server/dist/current/desktop.js"), f"--pp-desktop-package-root={ROOT}"]
    watch = Watch()
    with (data / "printpartner.lock").open("w+b") as lock, \
            (evidence / "stdout.log").open("wb") as stdout, (evidence / "stderr.log").open("wb") as stderr:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with inherited_lock(lock.fileno()):
            child = subprocess.Popen(command, cwd=ROOT / "web", stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                     env=env, start_new_session=True, pass_fds=(198,))
        watch.backend = child.pid
        receipt = {"case": "built_backend_listeners", "platform": sys.platform, "pid": child.pid, "control": control,
                   "baseline_user_listeners": len(watch.baseline)}
        try:
            setup = {"version": 1, "data_dir": str(data), "socket_path": str(socket_path), "generation": generation,
                     "key": key, "parent_pid": os.getpid(), "port": 43123}
            child.stdin.write((json.dumps(setup) + "\n").encode())
            child.stdin.flush()
            deadline = time.monotonic() + STARTUP_SECONDS
            while True:
                watch.poll()
                require(child.poll() is None, f"backend exited before readiness; see {evidence}")
                try:
                    ready = health(socket_path, generation, key)
                    break
                except (OSError, http.client.HTTPException):
                    require(time.monotonic() < deadline, f"backend readiness timed out; see {evidence}")
                    time.sleep(.05)
            ready_at = time.monotonic()
            receipt["ready"] = {"polls": watch.polls}
            require(ready["authenticated"] is True and ready["data_dir"] == str(data), f"unexpected health: {ready}")
            receipt.update(assert_private_socket(socket_path))
            receipt["exercised"] = {"/health": health(socket_path, generation, key)["authenticated"],
                                    "/api/v1/sources": signed_get(socket_path, generation, key, "/api/v1/sources")}
            require(receipt["exercised"] == {"/health": True, "/api/v1/sources": 200},
                    f"exercise failed: {receipt['exercised']}")
            while time.monotonic() - ready_at < WINDOW_SECONDS:
                watch.poll()
                require(child.poll() is None, f"backend exited during the observation window; see {evidence}")
                time.sleep(POLL_SECONDS)
            receipt["window"] = {"seconds": round(time.monotonic() - ready_at, 2), "polls": watch.polls}
            child.stdin.close()
            stop_deadline = time.monotonic() + STOP_SECONDS
            while child.poll() is None:
                watch.poll()
                require(time.monotonic() < stop_deadline, f"backend did not stop on stdin EOF; see {evidence}")
                time.sleep(POLL_SECONDS)
            watch.poll()
            require(child.returncode == -signal.SIGKILL, f"backend stopped with {child.returncode}, not its own SIGKILL")
            receipt.update(returncode=child.returncode, new_listeners=[])
            return receipt
        except ListenerFound as found:
            found.seconds_after_ready = round(time.monotonic() - ready_at, 2) if "ready" in receipt else None
            raise
        finally:
            if not group_absent(child.pid):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
            receipt.update(polls=watch.polls, killed_after_stop=kill_token_carriers(token))
            write_json(evidence / "receipt.json", receipt)
            shutil.rmtree(runtime, ignore_errors=True)


def prove_control(node, evidence, control):
    try:
        run_backend(node, evidence / control, control)
    except ListenerFound as error:
        found = error.found
        result = {"control": control, "expected_failure": str(error), "seconds_after_ready": error.seconds_after_ready,
                  "listener_pids_gone": all(pid_gone(listener["pid"]) for listener in found)}
    else:
        raise AssertionError(f"negative control {control} unexpectedly passed")
    write_json(evidence / control / "negative-control.json", result)
    print(json.dumps(result), flush=True)
    require(result["listener_pids_gone"], f"negative control {control} left a listener running: {result}")
    return result, found, json.loads((evidence / control / "receipt.json").read_text())["pid"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    require(sys.platform in ("linux", "darwin"), "this proof requires Linux or macOS")
    require(shutil.which("lsof") is not None, "this proof requires lsof")
    require(args.node is not None, "supply --node with Node 24.21.0")
    node = Path(args.node).resolve(strict=True)
    node_identity = json.loads(subprocess.check_output([str(node), "-p",
        "JSON.stringify({version:process.version,os:process.platform,arch:process.arch})"], text=True))
    require(node_identity["version"] == "v24.21.0" and node_identity["os"] == sys.platform,
            f"wrong Node identity: {node_identity}")
    require((ROOT / "web/apps/server/dist/current/desktop.js").is_file(), "build web/apps/server before running this proof")
    args.evidence.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="run-", dir=args.evidence.resolve())).resolve()
    print(f"Evidence: {evidence}", flush=True)
    write_json(evidence / "node-identity.json", node_identity)
    receipt = run_backend(node, evidence / "backend")
    print(json.dumps(receipt), flush=True)

    _, found, backend = prove_control(node, evidence, "child_listener")
    require(all(listener["pid"] != backend and listener["in_backend_group"] for listener in found),
            f"child listener not attributed to the backend's group: {found}")
    _, found, backend = prove_control(node, evidence, "detached_grandchild_listener")
    require(all(listener.get("pgid") not in (None, backend) and listener.get("ppid") != backend
                and not listener["in_backend_group"] and listener["args"] for listener in found),
            f"grandchild listener was not detached from the backend: {found}")
    result, found, backend = prove_control(node, evidence, "late_backend_listener")
    require(all(listener["pid"] == backend for listener in found) and result["seconds_after_ready"] >= .9,
            f"late listener was not opened by the backend after readiness: {result}")


if __name__ == "__main__":
    main()
