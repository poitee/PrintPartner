"""Prove the built desktop backend listens only on its private Unix socket (Linux and macOS)."""

import argparse
import fcntl
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

from built_backend_lifecycle import ROOT, STARTUP_SECONDS, STOP_SECONDS, group_absent, health, inherited_lock, require, write_json

NEGATIVE_CONTROL = """
require("node:child_process").spawn(process.execPath, ["-e",
  "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('listening'))"],
  { stdio: ["ignore", "inherit", "inherit"] });
"""


def process_tree(root):
    rows = [line.split() for line in subprocess.check_output(["ps", "-A", "-o", "pid=,ppid=,pgid="], text=True).splitlines()]
    tree = {root} | {int(pid) for pid, _, pgid in rows if int(pgid) == root}
    while True:
        grown = tree | {int(pid) for pid, ppid, _ in rows if int(ppid) in tree}
        if grown == tree:
            return sorted(tree)
        tree = grown


def lsof(pids, *selection):
    result = subprocess.run(["lsof", "-w", "-nP", "-a", "-p", ",".join(map(str, pids)), *selection],
                            capture_output=True, text=True)
    require(result.returncode in (0, 1) and not result.stderr, f"lsof failed: {result.returncode} {result.stderr}")
    require(result.returncode == 0 or not result.stdout, f"lsof exit 1 with output: {result.stdout}")
    return result.stdout.splitlines()[1:]


def network_listeners(root):
    pids = process_tree(root)
    return {"pids": pids,
            "tcp_listen": lsof(pids, "-iTCP", "-sTCP:LISTEN"),
            "udp": lsof(pids, "-iUDP")}


def assert_no_network_listeners(observed):
    require(not observed["tcp_listen"] and not observed["udp"], f"network listener found: {observed}")


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


def prove_backend(node, evidence):
    data = evidence / "data"
    data.mkdir(mode=0o700)
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if name in os.environ}
    env.update(PP_STORAGE_CORE_LOCK="1", PRINT_PARTNER_UPDATE_CHECK="0", AI_ENABLED="0", HOST="127.0.0.1", DEPLOY_MODE="self-host")
    # A short temp path keeps the socket under the 104-byte macOS limit.
    runtime = Path(tempfile.mkdtemp(prefix="pp-listen-")).resolve()
    socket_path = runtime / "backend.sock"
    generation, key = secrets.token_hex(16), secrets.token_hex(32)
    command = [str(node), "--no-global-search-paths",
               "--import", str(ROOT / "web/apps/server/dist/current/desktop-resolution.js"),
               str(ROOT / "web/apps/server/dist/current/desktop.js"), f"--pp-desktop-package-root={ROOT}"]
    with (data / "printpartner.lock").open("w+b") as lock, \
            (evidence / "stdout.log").open("wb") as stdout, (evidence / "stderr.log").open("wb") as stderr:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with inherited_lock(lock.fileno()):
            child = subprocess.Popen(command, cwd=ROOT / "web", stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                     env=env, start_new_session=True, pass_fds=(198,))
        try:
            setup = {"version": 1, "data_dir": str(data), "socket_path": str(socket_path), "generation": generation,
                     "key": key, "parent_pid": os.getpid(), "port": 43123}
            child.stdin.write((json.dumps(setup) + "\n").encode())
            child.stdin.flush()
            deadline = time.monotonic() + STARTUP_SECONDS
            while True:
                require(child.poll() is None, f"backend exited before readiness; see {evidence}")
                try:
                    ready = health(socket_path, generation, key)
                    break
                except (OSError, http.client.HTTPException):
                    require(time.monotonic() < deadline, f"backend readiness timed out; see {evidence}")
                    time.sleep(.05)
            require(ready["authenticated"] is True and ready["data_dir"] == str(data), f"unexpected health: {ready}")
            receipt = {"case": "built_backend_listeners", "platform": sys.platform, "pid": child.pid,
                       **assert_private_socket(socket_path), **network_listeners(child.pid)}
            write_json(evidence / "receipt.json", receipt)
            print(json.dumps(receipt), flush=True)
            assert_no_network_listeners(receipt)
            child.stdin.close()
            child.wait(timeout=STOP_SECONDS)
        finally:
            if not group_absent(child.pid):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
            shutil.rmtree(runtime, ignore_errors=True)


def prove_negative_control(node, evidence):
    parent = subprocess.Popen([str(node), "-e", NEGATIVE_CONTROL], stdout=subprocess.PIPE, text=True,
                              start_new_session=True)
    try:
        require(parent.stdout.readline().strip() == "listening", "negative control listener did not start")
        observed = network_listeners(parent.pid)
        try:
            assert_no_network_listeners(observed)
        except AssertionError as error:
            listener_pids = {int(line.split()[1]) for line in observed["tcp_listen"]}
            require(len(observed["pids"]) == 2 and listener_pids and parent.pid not in listener_pids,
                    f"negative control did not find the descendant's listener: {observed}")
            control = {"expected_failure": str(error), **observed}
            write_json(evidence / "negative-control.json", control)
            print(json.dumps(control), flush=True)
        else:
            raise AssertionError("negative control unexpectedly passed")
    finally:
        os.killpg(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)


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
    prove_backend(node, evidence)
    prove_negative_control(node, evidence)


if __name__ == "__main__":
    main()
