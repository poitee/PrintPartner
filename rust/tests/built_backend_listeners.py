"""Prove the built desktop backend listens only on its private Unix socket (Linux and macOS)."""

import argparse
from collections import Counter, namedtuple
import fcntl
import hashlib
import hmac
import http.client
import ipaddress
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
    # Non-dumpable hides the helper's fds and environment from same-user lsof and token cleanup,
    # so it exits on its own once the harness removes the runtime directory.
    "non_dumpable_listener": """
import { spawn } from "node:child_process";
const helper = `
import ctypes, os, socket, time
PR_SET_DUMPABLE = 4
assert ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
runtime = os.path.dirname(os.environ["PP_LISTENER_CONTROL_SOCKET"])
while os.path.isdir(runtime):
    time.sleep(.05)
`;
spawn(process.env.PP_LISTENER_CONTROL_PYTHON, ["-c", helper], { detached: true, stdio: "ignore" }).unref();
""",
}

Endpoint = namedtuple("Endpoint", "protocol address port uid inode")

# The kernel lists every socket in /proc/net without inspecting its owner, so dumpability cannot hide one.
PROC_TABLES = {"tcp": "tcp4", "tcp6": "tcp6", "udp": "udp4", "udp6": "udp6"}
OBSERVATION = {"linux": "/proc/net/{tcp,tcp6,udp,udp6}", "darwin": "netstat -an -p tcp; netstat -an -p udp"}
TCP_LISTEN, UDP_UNCONNECTED = "0A", "07"


def proc_address(text):
    raw = bytes.fromhex(text)
    require(len(raw) in (4, 16), f"bad /proc/net address: {text}")
    # Each 32-bit word is printed in host byte order, little-endian on x86-64 and arm64.
    return str(ipaddress.ip_address(b"".join(raw[word:word + 4][::-1] for word in range(0, len(raw), 4))))


def proc_endpoints(table, text):
    lines = text.splitlines()
    require(lines and lines[0].split()[:2] == ["sl", "local_address"], f"unparseable /proc/net/{table} header: {lines[:1]}")
    protocol = PROC_TABLES[table]
    found = []
    for row in lines[1:]:
        fields = row.split()
        address, port = fields[1].split(":")
        if fields[3] == (TCP_LISTEN if protocol.startswith("tcp") else UDP_UNCONNECTED) and int(port, 16):
            found.append(Endpoint(protocol, proc_address(address), int(port, 16), int(fields[7]), int(fields[9])))
    return found


def netstat_endpoints(text):
    found = []
    for row in text.splitlines():
        fields = row.split()
        if not fields or row.startswith("Active Internet connections") or fields[0] == "Proto":
            continue
        protocol = fields[0]
        require(protocol in ("tcp4", "tcp6", "tcp46", "udp4", "udp6", "udp46") and len(fields) in (5, 6),
                f"unparseable netstat row: {row!r}")
        address, _, port = fields[3].rpartition(".")
        listening = fields[5:] == ["LISTEN"] if protocol.startswith("tcp") else fields[4] == "*.*" and port != "*"
        if listening:
            found.append(Endpoint(protocol, address, int(port), None, None))
    return found


def endpoints():
    """The kernel's system-wide multiset of listening TCP and bound, unconnected UDP endpoints."""
    try:
        if sys.platform == "linux":
            found = [endpoint for table in PROC_TABLES
                     for endpoint in proc_endpoints(table, Path(f"/proc/net/{table}").read_text())]
        else:
            found = [endpoint for protocol in ("tcp", "udp")
                     for endpoint in netstat_endpoints(subprocess.check_output(["netstat", "-an", "-p", protocol], text=True))]
    except (OSError, ValueError, IndexError, AssertionError, subprocess.CalledProcessError) as error:
        raise AssertionError(f"observation unavailable: {error!r}") from error
    return Counter(found)


LINUX_PROC_FIXTURE = """\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 5C117AFD0000E0A10000000005683158:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21605 2 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:1F90 00000000000000000000000001000000:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 20 4 30 10 -1
   2: 00000000000000000000000001000000:9C41 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0
"""
MACOS_NETSTAT_FIXTURE = """\
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.50701        *.*                    LISTEN
tcp6       0      0  ::1.631                *.*                    LISTEN
tcp46      0      0  *.7000                 *.*                    LISTEN
tcp6       0      0  fe80::1%lo0.49152      *.*                    LISTEN
tcp4       0      0  192.168.1.20.53422     17.57.146.20.5223      ESTABLISHED
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
udp4       0      0  *.5353                 *.*
udp6       0      0  *.5353                 *.*
udp46      0      0  *.62093                *.*
udp4       0      0  192.168.1.20.61234     192.168.1.1.53
udp4       0      0  *.*                    *.*
"""


def parser_self_test():
    require(proc_endpoints("tcp6", LINUX_PROC_FIXTURE) == [
        Endpoint("tcp6", "fd7a:115c:a1e0::5831:6805", 443, 0, 21605), Endpoint("tcp6", "::1", 40001, 1000, 41002)],
        f"/proc/net parser mismatch: {proc_endpoints('tcp6', LINUX_PROC_FIXTURE)}")
    require(netstat_endpoints(MACOS_NETSTAT_FIXTURE) == [
        Endpoint("tcp4", "127.0.0.1", 50701, None, None), Endpoint("tcp6", "::1", 631, None, None),
        Endpoint("tcp46", "*", 7000, None, None), Endpoint("tcp6", "fe80::1%lo0", 49152, None, None),
        Endpoint("udp4", "*", 5353, None, None), Endpoint("udp6", "*", 5353, None, None),
        Endpoint("udp46", "*", 62093, None, None)],
        f"netstat parser mismatch: {netstat_endpoints(MACOS_NETSTAT_FIXTURE)}")
    truncated_proc = LINUX_PROC_FIXTURE.splitlines()[0] + "\n   0: 0100007F:1F90\n"
    for parse, broken in ((netstat_endpoints, "tcp4 0 0 127.0.0.1.80"), (netstat_endpoints, "unix 0 0 /tmp/sock"),
                          (netstat_endpoints, "tcp4 0 0 127.0.0.1.http *.* LISTEN"),
                          (lambda text: proc_endpoints("tcp", text), ""),
                          (lambda text: proc_endpoints("tcp", text), truncated_proc)):
        try:
            parse(broken)
        except (AssertionError, IndexError, ValueError):
            continue
        raise AssertionError(f"parser accepted {broken!r}")


class ListenerFound(AssertionError):
    def __init__(self, new, baseline, found):
        self.new, self.baseline, self.found = new, baseline, found
        unclear = [finding for finding in found if finding["owners"] == "unattributed"
                   or not all(owner["in_backend_group"] for owner in finding["owners"])]
        hint = f"; unattributed or outside the backend's process group, check in case it is unrelated: {unclear}" if unclear else ""
        super().__init__(f"network listener found: {found}{hint}")


class Watch:
    """Fails as soon as the kernel lists a listening endpoint that was absent before launch, whoever owns it."""

    def __init__(self):
        self.baseline = endpoints()
        self.backend = None
        self.polls = 0

    def poll(self):
        self.polls += 1
        new = endpoints() - self.baseline
        if new:
            raise ListenerFound(new, self.baseline, [self.describe(endpoint) for endpoint in new.elements()])

    def describe(self, endpoint):
        # lsof only attributes; a process it cannot inspect still fails the proof as unattributed.
        state = ["-sTCP:LISTEN"] if endpoint.protocol.startswith("tcp") else []
        rows = subprocess.run(["lsof", "-w", "-nP", "-a", f"-i{endpoint.protocol[:3].upper()}:{endpoint.port}", *state,
                               "-F", "p"], capture_output=True, text=True).stdout.splitlines()
        pids = sorted({int(row[1:]) for row in rows if row.startswith("p")})
        return {"endpoint": f"{endpoint.protocol} {endpoint.address}:{endpoint.port}", "uid": endpoint.uid,
                "inode": endpoint.inode, "owners": [self.lineage(pid) for pid in pids] or "unattributed"}

    def lineage(self, pid):
        row = subprocess.run(["ps", "-ww", "-o", "ppid=,pgid=,args=", "-p", str(pid)],
                             capture_output=True, text=True).stdout.split(None, 2)
        lineage = {"ppid": int(row[0]), "pgid": int(row[1]), "args": row[2].strip()} if len(row) == 3 else {}
        return {"pid": pid, **lineage, "in_backend_group": self.backend in (pid, lineage.get("pgid"))}


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
        env.update(PP_LISTENER_CONTROL_SOCKET=str(socket_path), PP_LISTENER_CONTROL_PYTHON=sys.executable)
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
                   "observation": OBSERVATION[sys.platform], "baseline_endpoints": sum(watch.baseline.values())}
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
        deadline = time.monotonic() + 5
        while (lingering := (endpoints() - error.baseline) & error.new) and time.monotonic() < deadline:
            time.sleep(.05)
        result = {"control": control, "expected_failure": str(error), "seconds_after_ready": error.seconds_after_ready,
                  "listeners_gone": not lingering}
    else:
        raise AssertionError(f"negative control {control} unexpectedly passed")
    write_json(evidence / control / "negative-control.json", result)
    print(json.dumps(result), flush=True)
    require(result["listeners_gone"], f"negative control {control} left a listener running: {list(lingering)}")
    return result, found, json.loads((evidence / control / "receipt.json").read_text())["pid"]


def owners(found):
    require(all(finding["owners"] != "unattributed" for finding in found), f"listener was not attributed: {found}")
    return [owner for finding in found for owner in finding["owners"]]


def child_opened(result, found, backend):
    require(all(owner["pid"] != backend and owner["in_backend_group"] for owner in owners(found)),
            f"child listener not attributed to the backend's group: {found}")


def detached_opened(result, found, backend):
    require(all(owner.get("pgid") not in (None, backend) and owner.get("ppid") != backend
                and not owner["in_backend_group"] and owner["args"] for owner in owners(found)),
            f"grandchild listener was not detached from the backend: {found}")


def backend_opened_late(result, found, backend):
    require(all(owner["pid"] == backend for owner in owners(found)) and result["seconds_after_ready"] >= .9,
            f"late listener was not opened by the backend after readiness: {result}")


def hidden_from_lsof(result, found, backend):
    require(all(finding["owners"] == "unattributed" and finding["uid"] == os.getuid() for finding in found),
            f"non-dumpable listener was attributed, so the control did not hide it from lsof: {found}")


CONTROL_CHECKS = {"child_listener": child_opened, "detached_grandchild_listener": detached_opened,
                  "late_backend_listener": backend_opened_late, "non_dumpable_listener": hidden_from_lsof}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    require(sys.platform in ("linux", "darwin"), "this proof requires Linux or macOS")
    require(shutil.which("lsof") is not None, "this proof requires lsof to attribute listeners")
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
    parser_self_test()
    print(json.dumps({"parser_self_test": "passed", "observation": OBSERVATION[sys.platform]}), flush=True)
    receipt = run_backend(node, evidence / "backend")
    print(json.dumps(receipt), flush=True)

    for control, check in CONTROL_CHECKS.items():
        if control == "non_dumpable_listener" and sys.platform == "darwin":
            print(json.dumps({"control": control, "skipped": "macOS has no PR_SET_DUMPABLE"}), flush=True)
        else:
            check(*prove_control(node, evidence, control))


if __name__ == "__main__":
    main()
