"""Run the built desktop backend, not a simulator. Linux headless proof only."""

import argparse
import ctypes
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import http.client
import json
import multiprocessing
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
OBSERVER = Path(__file__).with_name("built_backend_observer.cjs")
STARTUP_SECONDS = 40
STOP_SECONDS = 5


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def group_absent(pid):
    try:
        os.killpg(pid, 0)
        return False
    except ProcessLookupError:
        return True


def pid_absent(pid):
    return not Path(f"/proc/{pid}").exists()


def identity(pid):
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return f"{boot}:{stat[19]}"


def events_at(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def health(socket_path, generation, key):
    assertion = {"version": 1, "generation": generation, "tenant": "default",
                 "actor": "desktop-owner", "method": "GET", "target": "/health",
                 "issued_at": int(time.time() * 1000)}
    encoded = json.dumps(assertion, separators=(",", ":")).encode().hex()
    signature = hmac.new(bytes.fromhex(key), encoded.encode(), hashlib.sha256).hexdigest()
    connection = http.client.HTTPConnection("desktop-compat", timeout=1)
    connection.sock = socket.socket(socket.AF_UNIX)
    connection.sock.settimeout(1)
    try:
        connection.sock.connect(str(socket_path))
        connection.request("GET", "/health", headers={"x-pp-principal": encoded,
                                                     "x-pp-signature": signature})
        response = connection.getresponse()
        require(response.status == 200, f"health status {response.status}")
        return json.loads(response.read())
    finally:
        connection.close()


@contextmanager
def inherited_lock(lock_fd):
    try:
        saved = os.dup(198)
    except OSError:
        saved = None
    try:
        os.dup2(lock_fd, 198)
        yield
    finally:
        if saved is None:
            os.close(198)
        else:
            os.dup2(saved, 198)
            os.close(saved)


@contextmanager
def owned_child(command, lock_fd, output, env):
    child = None
    cleanup = {"external_sigkill": False}
    with (output / "stdout.log").open("wb") as stdout, (output / "stderr.log").open("wb") as stderr:
        try:
            with inherited_lock(lock_fd):
                child = subprocess.Popen(command, cwd=ROOT / "web", stdin=subprocess.PIPE,
                                         stdout=stdout, stderr=stderr, env=env,
                                         start_new_session=True, pass_fds=(198,))
            write_json(output / "child.json", {"pid": child.pid, "command": command})
            yield child
        finally:
            if child is not None:
                if not group_absent(child.pid):
                    cleanup["external_sigkill"] = True
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
                if child.stdin and not child.stdin.closed:
                    child.stdin.close()
                cleanup.update(pid=child.pid, returncode=child.returncode,
                               pid_absent=pid_absent(child.pid), group_absent=group_absent(child.pid))
                write_json(output / "guard-cleanup.json", cleanup)
                require(cleanup["pid_absent"] and cleanup["group_absent"], "guard left a process behind")


def _subreaper_timeout(signum, frame):
    raise TimeoutError("isolated proof exceeded its deadline")


def _subreaper_worker(connection, parent_connection, function, args, cleanup_path):
    children_path = Path(f"/proc/self/task/{os.getpid()}/children")

    def reap_owned_descendants():
        killed, reaped = set(), []
        deadline = time.monotonic() + STOP_SECONDS
        while True:
            try:
                while True:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if not pid:
                        break
                    reaped.append(pid)
            except ChildProcessError:
                return {"killed": sorted(killed), "reaped": reaped, "children_absent": True}
            # Killing a parent reparents even session-detached, empty-env descendants to this worker.
            children = children_path.read_text().split()
            for child in children:
                pid = int(child)
                try:
                    os.kill(pid, signal.SIGKILL)
                    killed.add(pid)
                except ProcessLookupError:
                    pass
            require(time.monotonic() < deadline, f"run-owned descendants survived cleanup: {children}")
            time.sleep(.01)

    parent_connection.close()
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        require(libc.prctl(36, 1, 0, 0, 0) == 0,
                f"PR_SET_CHILD_SUBREAPER failed: errno {ctypes.get_errno()}")
        try:
            children_path.read_text()
        except OSError as error:
            raise RuntimeError(
                f"subreaper containment requires readable {children_path} "
                "(Linux CONFIG_PROC_CHILDREN) before running the proof"
            ) from error
        signal.signal(signal.SIGTERM, _subreaper_timeout)
        try:
            outcome = ("result", function(*args))
        except BaseException as error:
            if isinstance(error, AssertionError):
                outcome = ("assertion", type(error), error.args, error.__dict__)
            else:
                outcome = ("error", traceback.format_exc())
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            write_json(cleanup_path, reap_owned_descendants())
        connection.send(outcome)
    except BaseException:
        connection.send(("error", traceback.format_exc()))
    finally:
        connection.close()


def run_in_subreaper(function, args, cleanup_path, timeout):
    """Run one Linux proof in its own process so adoption cannot include caller children."""
    require(sys.platform == "linux", "subreaper containment requires Linux")
    context = multiprocessing.get_context("fork")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(target=_subreaper_worker,
                             args=(sender, receiver, function, args, cleanup_path))
    worker.start()
    sender.close()
    try:
        timed_out = not receiver.poll(timeout)
        if timed_out:
            worker.terminate()
            require(receiver.poll(3 * STOP_SECONDS + 1), "subreaper timed out before reporting descendant cleanup")
        outcome = receiver.recv()
    finally:
        receiver.close()
        worker.join(timeout=STOP_SECONDS)
        if worker.is_alive():
            worker.kill()
            worker.join(timeout=STOP_SECONDS)
    if timed_out:
        raise TimeoutError(f"isolated proof exceeded {timeout} seconds; see {cleanup_path}")
    require(worker.exitcode == 0, f"subreaper worker failed: {worker.exitcode}")
    if outcome[0] == "result":
        return outcome[1]
    if outcome[0] == "assertion":
        _, kind, arguments, attributes = outcome
        error = BaseException.__new__(kind)
        BaseException.__init__(error, *arguments)
        error.__dict__.update(attributes)
        raise error
    raise RuntimeError(outcome[1])


def assert_previous(completed):
    for record in completed:
        require(pid_absent(record["pid"]), "old child PID still exists")
        require(group_absent(record["pid"]), "old child group still exists")
        require(not Path(record["socket"]).exists(), "old socket still exists")
        require(Path(record["events_path"]).read_bytes() == record["event_bytes"], "old child emitted new events")


def run_cycles(node, evidence, suppress_eof=False):
    evidence.mkdir()
    data = evidence / "data"
    data.mkdir(mode=0o700)
    completed = []
    receipts = []
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if name in os.environ}
    env.update(PP_STORAGE_CORE_LOCK="1", PRINT_PARTNER_UPDATE_CHECK="0", AI_ENABLED="0", HOST="127.0.0.1", DEPLOY_MODE="self-host")
    with (data / "printpartner.lock").open("w+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for cycle in range(1 if suppress_eof else 3):
            assert_previous(completed)
            output = evidence / f"cycle-{cycle}"
            output.mkdir()
            # Keep the UDS path below Linux's 108-byte limit, independent of artifact path.
            with tempfile.TemporaryDirectory(prefix="pp-built-") as runtime:
                socket_path = Path(runtime) / "backend.sock"
                events = output / "events.jsonl"
                generation, key = secrets.token_hex(16), secrets.token_hex(32)
                command = [str(node), "--no-global-search-paths", "--require", str(OBSERVER),
                           "--import", str(ROOT / "web/apps/server/dist/current/desktop-resolution.js"),
                           str(ROOT / "web/apps/server/dist/current/desktop.js"),
                           f"--pp-desktop-package-root={ROOT}", f"--pp-lifecycle-events={events}"]
                if suppress_eof:
                    command.append("--pp-lifecycle-suppress-eof")
                with owned_child(command, lock.fileno(), output, env) as child:
                    child_identity = identity(child.pid)
                    setup = {"version": 1, "data_dir": str(data), "socket_path": str(socket_path),
                             "generation": generation, "key": key,
                             "parent_pid": os.getpid(), "port": 43123}
                    child.stdin.write((json.dumps(setup) + "\n").encode())
                    child.stdin.flush()
                    deadline = time.monotonic() + STARTUP_SECONDS
                    while True:
                        require(child.poll() is None, f"backend exited before readiness; see {output}")
                        try:
                            ready = health(socket_path, generation, key)
                            break
                        except (OSError, http.client.HTTPException):
                            require(time.monotonic() < deadline, f"backend readiness timed out; see {output}")
                            time.sleep(.05)
                    require(ready["ok"] is True and ready["db"]["connected"] is True, "real database health failed")
                    require(ready["db"]["driver"] == "sqlite", "real SQLite backend required")
                    require(ready["authenticated"] is True, "desktop principal was not admitted")
                    require(ready["data_dir"] == str(data), "backend used another data directory")
                    require(socket_path.stat().st_mode & 0o777 == 0o600, "socket permissions changed")
                    require(events_at(events) == [{"event": "start", "pid": child.pid}], "unexpected event before EOF")
                    assert_previous(completed)
                    started = time.monotonic()
                    child.stdin.close()
                    try:
                        child.wait(timeout=STOP_SECONDS)
                    except subprocess.TimeoutExpired as error:
                        raise AssertionError("backend did not stop after stdin EOF") from error
                    elapsed = time.monotonic() - started
                    observed = events_at(events)
                    require(observed == [{"event": "start", "pid": child.pid},
                                         {"event": "stdin_end", "pid": child.pid},
                                         {"event": "kill", "pid": child.pid, "target": -child.pid, "signal": "SIGKILL"}],
                            f"shutdown cause differs from EOF: {observed}")
                    require(child.returncode == -signal.SIGKILL, "expected backend's own group SIGKILL")
                    require(pid_absent(child.pid) and group_absent(child.pid), "backend process/group survived")
                    require(not socket_path.exists(), "backend socket survived app.close")
                    receipt = {"case": "built_backend_lifecycle", "cycle": cycle,
                               "pid": child.pid, "process_identity": child_identity, "generation": generation,
                               "ready": ready, "events": observed, "returncode": child.returncode,
                               "stdin_closed": True, "sigterm_sent": False, "external_cleanup_required": False,
                               "pid_absent": True, "group_absent": True, "socket_absent": True,
                               "spawn_count": sum(event["event"] == "start" for event in observed),
                               "shutdown_ms": round(elapsed * 1000),
                               "previous_pids_absent_while_ready": [record["pid"] for record in completed]}
                    write_json(output / "receipt.json", receipt)
                    print(json.dumps(receipt), flush=True)
                    receipts.append(receipt)
                    completed.append({"pid": child.pid, "socket": str(socket_path),
                                      "events_path": str(events), "event_bytes": events.read_bytes()})
        assert_previous(completed)
    write_json(evidence / "receipts.json", receipts)
    return receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    require(sys.platform == "linux", "this proof requires Linux /proc and process groups")
    require(args.node is not None, "supply --node with native Node 24.21.0")
    node = Path(args.node).resolve(strict=True)
    with node.open("rb") as binary:
        require(binary.read(4) == b"\x7fELF", "--node must be native Linux ELF, not a dispatcher")
    node_identity = json.loads(subprocess.check_output([str(node), "-p",
        "JSON.stringify({version:process.version,abi:process.versions.modules,os:process.platform,arch:process.arch})"], text=True))
    require(node_identity == {"version": "v24.21.0", "abi": "137", "os": "linux",
                              "arch": {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())},
            f"wrong native Node identity: {node_identity}")
    entry = ROOT / "web/apps/server/dist/current/desktop.js"
    require(entry.is_file(), "build web/apps/server before running this proof")
    args.evidence = args.evidence.resolve()
    args.evidence.mkdir(parents=True, exist_ok=True)
    args.evidence = Path(tempfile.mkdtemp(prefix="run-", dir=args.evidence))
    print(f"Evidence: {args.evidence}", flush=True)
    artifact = {
        "entry": str(entry), "entry_resolved": str(entry.resolve()),
        "entry_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
        "node": str(node), "node_identity": node_identity,
        "node_sha256": hashlib.sha256(node.read_bytes()).hexdigest(),
        "server_version": json.loads((ROOT / "web/apps/server/package.json").read_text())["version"],
        "proof_class": "headless_unsigned_built_backend", "release_manifest_verified": False}
    write_json(args.evidence / "artifact-identity.json", artifact)
    run_cycles(node, args.evidence / "baseline")
    if args.negative_control:
        negative = args.evidence / "negative"
        try:
            run_cycles(node, negative, suppress_eof=True)
        except AssertionError as error:
            require(str(error) == "backend did not stop after stdin EOF", f"wrong negative failure: {error}")
            observed = events_at(negative / "cycle-0/events.jsonl")
            require([event["event"] for event in observed] == ["start", "stdin_end", "stdin_end_suppressed"],
                    "negative control did not suppress actual EOF")
            cleanup = json.loads((negative / "cycle-0/guard-cleanup.json").read_text())
            require(cleanup["external_sigkill"] and cleanup["pid_absent"] and cleanup["group_absent"],
                    "negative cleanup unproved")
            write_json(args.evidence / "negative-control.json", {"expected_failure": str(error),
                                                                "events": observed, "cleanup": cleanup})
        else:
            raise AssertionError("negative control unexpectedly passed")
        run_cycles(node, args.evidence / "restored")
    require(hashlib.sha256(entry.read_bytes()).hexdigest() == artifact["entry_sha256"],
            "built desktop entry changed during proof")
    write_json(args.evidence / "artifact-unchanged.json", {"entry_sha256": artifact["entry_sha256"],
                                                          "unchanged": True})


if __name__ == "__main__":
    main()
