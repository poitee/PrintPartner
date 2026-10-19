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
from backend_unix_listeners import UnixListenerFound, require_private_listener, unix_listeners

WINDOW_SECONDS = 4
POLL_SECONDS = .1
RUN_TOKEN = "PP_LISTENER_PROOF_RUN"

# Each control is preloaded into the built backend with --import.
CONTROLS = {
    "extra_backend_unix_listener": """
import { existsSync } from "node:fs";
import { createServer } from "node:net";
const waiting = setInterval(() => {
  if (!existsSync(process.env.PP_LISTENER_CONTROL_SOCKET)) return;
  clearInterval(waiting);
  setTimeout(() => createServer().listen(process.env.PP_LISTENER_CONTROL_SOCKET + ".extra").unref(), 1000).unref();
}, 50);
waiting.unref();
""",
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
    # Non-dumpable hides the helper's fds and environment from same-user inspection and token cleanup,
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

# Kernel-reported ownership: Linux /proc/net gives the socket's uid and inode, macOS netstat -v the owning pid and epid.
Endpoint = namedtuple("Endpoint", "protocol address port uid inode pids")

PROC_TABLES = {"tcp": "tcp4", "tcp6": "tcp6", "udp": "udp4", "udp6": "udp6"}
OBSERVATION = {"linux": "/proc/net/{tcp,tcp6,udp,udp6}; backend fd inodes intersected with /proc/<pid>/net/unix",
               "darwin": "netstat -anv -p tcp; netstat -anv -p udp; libproc backend SO_ACCEPTCONN sockets"}
TCP_LISTEN, UDP_UNCONNECTED = "0A", "07"
NETSTAT_PROTOCOLS = ("tcp4", "tcp6", "tcp46", "udp4", "udp6", "udp46")


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
            found.append(Endpoint(protocol, proc_address(address), int(port, 16), int(fields[7]), int(fields[9]), None))
    return found


def netstat_endpoints(text):
    found, pid_column, epid_column = [], None, None
    for row in text.splitlines():
        fields = row.split()
        if not fields or row.startswith("Active Internet connections"):
            continue
        if fields[0] == "Proto":
            # Columns are counted from the right: "Local Address" splits in two and UDP rows have no state.
            pid_column = next((len(fields) - index for index, name in enumerate(fields)
                               if name == "pid" or name.endswith(":pid")), None)
            epid_column = len(fields) - fields.index("epid") if "epid" in fields else None
            require(pid_column, f"netstat -v printed no pid column: {row!r}")
            continue
        protocol = fields[0]
        require(pid_column and protocol in NETSTAT_PROTOCOLS and len(fields) >= 5 + pid_column,
                f"unparseable netstat row: {row!r}")
        address, _, port = fields[3].rpartition(".")
        pids = (int(fields[-pid_column].rpartition(":")[2]), int(fields[-epid_column]) if epid_column else 0)
        listening = fields[5] == "LISTEN" if protocol.startswith("tcp") else fields[4] == "*.*" and port != "*"
        if listening:
            found.append(Endpoint(protocol, address, int(port), None, None, pids))
    require(pid_column, f"netstat printed no table header: {text[:200]!r}")
    return found


def netstat_output(result):
    """netstat can exit 0 with only a stderr warning after a sysctl or malloc failure, so stderr fails the read."""
    require(result.returncode == 0 and not result.stderr,
            f"netstat failed: returncode={result.returncode} stderr={result.stderr[:200]!r}")
    return result.stdout


def endpoints():
    """The kernel's system-wide multiset of listening TCP and bound, unconnected UDP endpoints."""
    try:
        if sys.platform == "linux":
            found = [endpoint for table in PROC_TABLES
                     for endpoint in proc_endpoints(table, Path(f"/proc/net/{table}").read_text())]
        else:
            found = [endpoint for protocol in ("tcp", "udp")
                     for endpoint in netstat_endpoints(netstat_output(subprocess.run(
                         ["netstat", "-anv", "-p", protocol], capture_output=True, text=True)))]
    except (OSError, ValueError, IndexError, AssertionError) as error:
        raise AssertionError(f"observation unavailable: {error!r}") from error
    return Counter(found)


def socket_pids(inode):
    """Processes holding the socket; a non-dumpable process's fds are unreadable, so it is missing here."""
    target, pids = f"socket:[{inode}]", []
    for entry in Path("/proc").iterdir():
        try:
            if entry.name.isdigit() and any(os.readlink(fd) == target for fd in (entry / "fd").iterdir()):
                pids.append(int(entry.name))
        except OSError:
            pass
    return pids


def process_uid(pid):
    row = subprocess.run(["ps", "-o", "uid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(row) if row else None


LINUX_PROC_FIXTURE = """\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 5C117AFD0000E0A10000000005683158:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21605 2 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:1F90 00000000000000000000000001000000:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 20 4 30 10 -1
   2: 00000000000000000000000001000000:9C41 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0
"""
MACOS_NETSTAT_FIXTURES = ("""\
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    process:pid    state  options           gencnt    flags   flags1 usscnt rtncnt fltrs
tcp4       0      0  127.0.0.1.50701        *.*                    LISTEN       131072  131072       node:4242  00100 00000006 000000000001a2b3 00000000 00000800      1      0 000001
tcp6       0      0  fe80::1%lo0.49152      *.*                    LISTEN       131072  131072  Google Ch:777  00100 00000006 000000000001a2b4 00000000 00000800      1      0 000001
tcp4       0      0  192.168.1.20.53422     17.57.146.20.5223      ESTABLISHED  131072  131768      apsd:396   00102 00000020 000000000001a2b5 00000000 00000800      1      0 000001
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    process:pid    state  options           gencnt    flags   flags1 usscnt rtncnt fltrs
udp4       0      0  *.5353                 *.*                                 786896    9216  mDNSRespo:412  00000 00000000 000000000000016c 00000000 00000800      1      0 000001
udp4       0      0  192.168.1.20.61234     192.168.1.1.53                      786896    9216  mDNSRespo:412  00000 00000000 000000000000016d 00000000 00000800      1      0 000001
udp4       0      0  *.*                    *.*                                 786896    9216  mDNSRespo:412  00000 00000000 000000000000016e 00000000 00000800      1      0 000001
""", """\
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options
tcp46      0      0  *.7000                 *.*                    LISTEN      131072 131072    463      0 0x0100 0x00000106
udp46      0      0  *.62093                *.*                                786896   9216    501    388 0x0000 0x00000000
""")


def parser_self_test():
    from test_backend_unix_listeners import self_test
    self_test()
    require(proc_endpoints("tcp6", LINUX_PROC_FIXTURE) == [
        Endpoint("tcp6", "fd7a:115c:a1e0::5831:6805", 443, 0, 21605, None),
        Endpoint("tcp6", "::1", 40001, 1000, 41002, None)],
        f"/proc/net parser mismatch: {proc_endpoints('tcp6', LINUX_PROC_FIXTURE)}")
    parsed = [netstat_endpoints(fixture) for fixture in MACOS_NETSTAT_FIXTURES]
    require(parsed == [[Endpoint("tcp4", "127.0.0.1", 50701, None, None, (4242, 0)),
                        Endpoint("tcp6", "fe80::1%lo0", 49152, None, None, (777, 0)),
                        Endpoint("udp4", "*", 5353, None, None, (412, 0))],
                       [Endpoint("tcp46", "*", 7000, None, None, (463, 0)),
                        Endpoint("udp46", "*", 62093, None, None, (501, 388))]],
            f"netstat parser mismatch: {parsed}")
    header = MACOS_NETSTAT_FIXTURES[1].splitlines()[1]
    truncated_proc = LINUX_PROC_FIXTURE.splitlines()[0] + "\n   0: 0100007F:1F90\n"
    table = MACOS_NETSTAT_FIXTURES[1]
    require(netstat_output(subprocess.CompletedProcess([], 0, table, "")) == table, "netstat_output rejected a clean read")
    for parse, broken in ((netstat_endpoints, ""),
                          (netstat_endpoints, "Active Internet connections (including servers)\n"),
                          (netstat_output, subprocess.CompletedProcess([], 0, table, "netstat: sysctl: Cannot allocate memory\n")),
                          (netstat_output, subprocess.CompletedProcess([], 1, table, "")),
                          (netstat_endpoints, "tcp4 0 0 127.0.0.1.80 *.* LISTEN 1 1 463 0 0x0100 0x00000106"),
                          (netstat_endpoints, "Proto Recv-Q Send-Q  Local Address  Foreign Address  (state)"),
                          (netstat_endpoints, f"{header}\nunix 0 0 /tmp/sock *.* LISTEN 1 1 463 0 0x0100 0x00000106"),
                          (netstat_endpoints, f"{header}\ntcp4 0 0 127.0.0.1.80 *.* LISTEN"),
                          (netstat_endpoints, f"{header}\ntcp4 0 0 127.0.0.1.http *.* LISTEN 1 1 463 0 0x0100 0x00000106"),
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
    """Fails as soon as the kernel lists a new listening endpoint owned by this user or an owner it cannot name."""

    def __init__(self, socket_path=None):
        self.baseline = endpoints()
        self.backend = None
        self.socket_path = socket_path
        self.ready = False
        self.last_unix = []
        self.polls = 0
        self.other_users = {}

    def poll(self):
        self.polls += 1
        owned, found = Counter(), []
        for endpoint, count in (endpoints() - self.baseline).items():
            if endpoint in self.other_users:
                continue
            finding = self.describe(endpoint)
            if os.getuid() in finding["uids"] or None in finding["uids"] or not finding["uids"]:
                owned[endpoint] = count
                found.append(finding)
            else:
                self.other_users[endpoint] = finding
        if owned:
            raise ListenerFound(owned, self.baseline, found)
        if self.backend is not None and self.socket_path is not None:
            self.last_unix = unix_listeners(self.backend)
            require_private_listener(self.socket_path, self.last_unix, self.ready)

    def describe(self, endpoint):
        if endpoint.pids is None:
            uids, pids = [endpoint.uid], socket_pids(endpoint.inode)
        else:
            pids = sorted({pid for pid in endpoint.pids if pid})
            uids = sorted({process_uid(pid) for pid in pids}, key=str)
        return {"endpoint": f"{endpoint.protocol} {endpoint.address}:{endpoint.port}", "uids": uids,
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
    watch = Watch(socket_path)
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
            watch.ready = True
            watch.poll()
            receipt["ready_unix_listeners"] = [listener._asdict() for listener in watch.last_unix]
            require(ready["authenticated"] is True and ready["data_dir"] == str(data), f"unexpected health: {ready}")
            receipt.update(assert_private_socket(socket_path))
            receipt["exercised"] = {"/health": health(socket_path, generation, key)["authenticated"],
                                    "/api/v1/sources": signed_get(socket_path, generation, key, "/api/v1/sources")}
            require(receipt["exercised"] == {"/health": True, "/api/v1/sources": 200},
                    f"exercise failed: {receipt['exercised']}")
            watch.poll()
            while time.monotonic() - ready_at < WINDOW_SECONDS:
                watch.poll()
                require(child.poll() is None, f"backend exited during the observation window; see {evidence}")
                time.sleep(POLL_SECONDS)
            receipt["window"] = {"seconds": round(time.monotonic() - ready_at, 2), "polls": watch.polls}
            watch.ready = False
            watch.socket_path = None
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
        except (ListenerFound, UnixListenerFound) as found:
            found.seconds_after_ready = round(time.monotonic() - ready_at, 2) if "ready" in receipt else None
            raise
        finally:
            if not group_absent(child.pid):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
            receipt.update(polls=watch.polls, killed_after_stop=kill_token_carriers(token),
                           backend_unix_listeners=[listener._asdict() for listener in watch.last_unix],
                           ignored_other_users=list(watch.other_users.values()))
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
    except UnixListenerFound as error:
        require(control == "extra_backend_unix_listener", f"unexpected Unix listener failure: {error}")
        found = error.found
        pid = json.loads((evidence / control / "receipt.json").read_text())["pid"]
        require(any(listener.pid == pid and listener.path == error.expected + ".extra" for listener in found),
                f"extra Unix listener was not attributed to the backend: {found}")
        require(error.seconds_after_ready is not None and error.seconds_after_ready >= .9,
                f"extra Unix listener was not observed after readiness: {error.seconds_after_ready}")
        result = {"control": control, "expected_failure": str(error), "seconds_after_ready": error.seconds_after_ready,
                  "listeners_gone": group_absent(pid)}
        lingering = []
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


def hidden_from_inspection(result, found, backend):
    require(all(finding["owners"] == "unattributed" and finding["uids"] == [os.getuid()] for finding in found),
            f"non-dumpable listener was attributed, so the control did not hide its fds: {found}")


CONTROL_CHECKS = {"child_listener": child_opened, "detached_grandchild_listener": detached_opened,
                  "late_backend_listener": backend_opened_late, "non_dumpable_listener": hidden_from_inspection}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    require(sys.platform in ("linux", "darwin"), "this proof requires Linux or macOS")
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
    prove_control(node, evidence, "extra_backend_unix_listener")

    for control, check in CONTROL_CHECKS.items():
        if control == "non_dumpable_listener" and sys.platform == "darwin":
            print(json.dumps({"control": control, "skipped": "macOS has no PR_SET_DUMPABLE"}), flush=True)
        else:
            check(*prove_control(node, evidence, control))


if __name__ == "__main__":
    main()
