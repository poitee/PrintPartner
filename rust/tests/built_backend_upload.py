"""Prove interrupted-upload recovery against the full built Linux desktop backend."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

import built_backend_lifecycle as lifecycle

ROOT = lifecycle.ROOT
PREFIX_BYTES = 64 * 1024
FILE_BYTES = 64 * 1024 * 1024
WAIT_SECONDS = 15
UNKNOWN_OUTCOME = (
    "Interrupted by process restart. Printer outcome is unknown, so this send was not marked successful. "
    "The staged file remains for an explicit retry. This process will not retry a print on its own."
)
NETWORK_FAILURE = "interrupted upload was resent automatically"
require = lifecycle.require
write_json = lifecycle.write_json


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def measured_artifacts(root):
    paths = [root / "web/node_modules", root / "web/apps/server/dist",
             root / "web/packages/contracts/dist", root / "web/packages/domain/dist"]
    measured = {}
    for base in paths:
        require(base.is_dir(), f"missing built dependency tree: {base}")
        for path in sorted(base.rglob("*")):
            if path.is_symlink():
                measured[str(path.relative_to(root))] = "symlink:" + os.readlink(path)
            elif path.is_file():
                measured[str(path.relative_to(root))] = sha256(path)
    source = root / "web/apps/server/src/services/printer-send-queue.ts"
    measured[str(source.relative_to(root))] = sha256(source)
    return measured


class MoonrakerPeer:
    def __init__(self, evidence):
        self.evidence = evidence
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.changed = threading.Condition(self.lock)
        self.uploads = []
        self.errors = []
        self.active = set()
        peer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self):
                self.request.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
                self.request.settimeout(WAIT_SECONDS)
                super().setup()
                with peer.lock:
                    peer.active.add(self.connection)

            def finish(self):
                try:
                    super().finish()
                finally:
                    with peer.lock:
                        peer.active.discard(self.connection)

            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path.startswith("/printer/objects/query"):
                    body = json.dumps({"result": {"status": {
                        "print_stats": {"state": "standby"},
                        "virtual_sdcard": {"progress": 0},
                    }}}).encode()
                    self.send_response(200)
                else:
                    body = b'{}'
                    self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                try:
                    require(self.path == "/server/files/upload", f"unexpected printer POST: {self.path}")
                    length = int(self.headers.get("Content-Length", "0"))
                    content_type = self.headers.get("Content-Type", "")
                    require(length > FILE_BYTES, "printer did not receive the large multipart Content-Length")
                    require(content_type.startswith("multipart/form-data; boundary="), "printer upload is not multipart")
                    prefix = self.rfile.read(PREFIX_BYTES)
                    require(len(prefix) == PREFIX_BYTES < length, "printer did not receive a strict upload prefix")
                    require(b'filename="interrupted.gcode"' in prefix and b"; GRE-448 upload proof" in prefix,
                            "printer prefix does not contain the staged G-code")
                    receive_buffer = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
                    require(receive_buffer <= PREFIX_BYTES, "printer receive buffer does not bound the unfinished transfer")
                    with peer.changed:
                        record = {"attempt": len(peer.uploads) + 1, "method": "POST", "target": self.path,
                                  "content_length": length, "content_type": content_type,
                                  "bytes_read": len(prefix), "prefix_sha256": hashlib.sha256(prefix).hexdigest(),
                                  "receive_buffer": receive_buffer,
                                  "response_sent": False, "read_stopped": True}
                        peer.uploads.append(record)
                        write_json(evidence / "peer-uploads.json", peer.uploads)
                        peer.changed.notify_all()
                    peer.stop.wait()
                    self.close_connection = True
                except Exception as error:
                    with peer.changed:
                        peer.errors.append(repr(error))
                        peer.changed.notify_all()
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .05}, name="moonraker-peer")

    def __enter__(self):
        self.thread.start()
        return self

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def wait_uploads(self, count):
        with self.changed:
            ready = self.changed.wait_for(lambda: len(self.uploads) >= count or self.errors, WAIT_SECONDS)
            require(not self.errors, f"printer peer failed: {self.errors}")
            require(ready, f"printer did not receive upload attempt {count}")

    def snapshot(self):
        with self.lock:
            require(not self.errors, f"printer peer failed: {self.errors}")
            return list(self.uploads)

    def __exit__(self, *_args):
        self.stop.set()
        self.server.shutdown()
        self.thread.join(timeout=2)
        with self.lock:
            connections = list(self.active)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.server_close()
        require(not self.thread.is_alive(), "printer listener thread survived cleanup")
        with self.lock:
            require(not self.active, "printer connection survived cleanup")
        write_json(self.evidence / "peer-cleanup.json", {
            "listener_stopped": True, "connections_closed": True, "handler_threads_joined": True,
            "uploads": self.uploads, "errors": self.errors,
        })


class Backend:
    def __init__(self, child, socket_path, generation, key, output):
        self.child = child
        self.socket_path = socket_path
        self.generation = generation
        self.key = key
        self.output = output
        self.requests = []

    def request(self, method, target, payload=None, content_type="application/json", status=200):
        assertion = {"version": 1, "generation": self.generation, "tenant": "default",
                     "actor": "desktop-owner", "method": method, "target": target,
                     "issued_at": int(time.time() * 1000)}
        encoded = json.dumps(assertion, separators=(",", ":")).encode().hex()
        signature = hmac.new(bytes.fromhex(self.key), encoded.encode(), hashlib.sha256).hexdigest()
        body = json.dumps(payload).encode() if payload is not None and not isinstance(payload, bytes) else payload
        connection = http.client.HTTPConnection("desktop-compat", timeout=WAIT_SECONDS)
        connection.sock = socket.socket(socket.AF_UNIX)
        connection.sock.settimeout(WAIT_SECONDS)
        try:
            connection.sock.connect(str(self.socket_path))
            headers = {"x-pp-principal": encoded, "x-pp-signature": signature}
            if body is not None:
                headers["Content-Type"] = content_type
            connection.request(method, target, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            result = json.loads(raw)
            self.requests.append({"method": method, "target": target, "status": response.status, "response": result})
            write_json(self.output / "http.json", self.requests)
            require(response.status == status, f"{method} {target}: expected {status}, got {response.status}: {raw[:1000]!r}")
            return result
        finally:
            connection.close()

    def stop(self, cause):
        if cause == "sigkill":
            os.killpg(self.child.pid, signal.SIGKILL)
        else:
            self.child.stdin.close()
        try:
            self.child.wait(timeout=12)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(f"backend did not stop after {cause}") from error
        require(self.child.returncode == -signal.SIGKILL, "backend did not terminate with group SIGKILL")
        require(lifecycle.pid_absent(self.child.pid) and lifecycle.group_absent(self.child.pid),
                "backend process or group survived interruption")
        events = lifecycle.events_at(self.output / "events.jsonl")
        if cause == "eof":
            require([event["event"] for event in events] == ["start", "stdin_end", "kill"],
                    f"EOF did not reach production shutdown: {events}")
            require(events[-1] == {"event": "kill", "pid": self.child.pid,
                                   "target": -self.child.pid, "signal": "SIGKILL"}, "unexpected EOF kill")
            require(not self.socket_path.exists(), "graceful EOF left its Unix socket")
        else:
            require([event["event"] for event in events] == ["start"], "crash unexpectedly ran EOF shutdown")
        write_json(self.output / "stop.json", {"cause": cause, "pid": self.child.pid,
                   "returncode": self.child.returncode, "events": events,
                   "pid_absent": True, "group_absent": True,
                   "socket_absent_before_fixture_cleanup": not self.socket_path.exists()})


@contextmanager
def backend(node, root, data, lock, output):
    output.mkdir()
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if name in os.environ}
    env.update(PP_STORAGE_CORE_LOCK="1", PRINT_PARTNER_UPDATE_CHECK="0", AI_ENABLED="0", HOST="127.0.0.1", DEPLOY_MODE="self-host")
    with tempfile.TemporaryDirectory(prefix="pp-upload-") as runtime:
        socket_path = Path(runtime) / "backend.sock"
        events = output / "events.jsonl"
        generation, key = secrets.token_hex(16), secrets.token_hex(32)
        entry = root / "web/apps/server/dist/current"
        command = [str(node), "--no-global-search-paths", "--require", str(lifecycle.OBSERVER),
                   "--import", str(entry / "desktop-resolution.js"), str(entry / "desktop.js"),
                   f"--pp-desktop-package-root={root}", f"--pp-lifecycle-events={events}"]
        try:
            with lifecycle.owned_child(command, lock.fileno(), output, env) as child:
                setup = {"version": 1, "data_dir": str(data), "socket_path": str(socket_path),
                         "generation": generation, "key": key,
                         "parent_pid": os.getpid(), "port": 43123}
                child.stdin.write((json.dumps(setup) + "\n").encode())
                child.stdin.flush()
                deadline = time.monotonic() + lifecycle.STARTUP_SECONDS
                while True:
                    require(child.poll() is None, f"backend exited before readiness; see {output}")
                    try:
                        ready = lifecycle.health(socket_path, generation, key)
                        break
                    except (OSError, http.client.HTTPException):
                        require(time.monotonic() < deadline, f"backend readiness timed out; see {output}")
                        time.sleep(.05)
                require(ready["ok"] and ready["db"]["connected"] and ready["db"]["driver"] == "sqlite"
                        and ready["authenticated"] and ready["data_dir"] == str(data), "real SQLite health failed")
                require(socket_path.stat().st_mode & 0o777 == 0o600, "Unix socket is not private")
                write_json(output / "ready.json", ready)
                yield Backend(child, socket_path, generation, key, output)
        finally:
            socket_path.unlink(missing_ok=True)
    require(not socket_path.exists(), "fixture left a Unix socket")


def sqlite_queue(data, evidence):
    path = data / "print-partner.db"
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5) as database:
        require(database.execute("PRAGMA integrity_check").fetchone() == ("ok",), "real SQLite integrity failed")
        rows = database.execute("SELECT tenant_id, key, value FROM app_settings WHERE key = 'printer.send_queue'").fetchall()
    require(len(rows) == 1 and rows[0][:2] == ("default", "printer.send_queue"), "wrong persisted tenant queue")
    items = json.loads(rows[0][2])
    require(len(items) == 1, "persisted queue lost or duplicated an item")
    write_json(evidence, {"database": str(path), "integrity": "ok", "rows": rows, "item": items[0]})
    return items[0]


def stage_upload(api, peer):
    host = api.request("POST", "/api/v1/integrations", {
        "type": "moonraker", "name": "GRE-448 local peer", "config": {"base_url": peer.origin},
    }, status=201)
    printer = {"id": "gre448-printer", "name": "GRE-448 printer", "integration_id": host["id"]}
    api.request("PUT", "/api/v1/printers", {"printers": [printer]})
    plan = api.request("POST", "/api/v1/plans", {"name": "GRE-448 interrupted upload"})
    boundary = "gre448-" + secrets.token_hex(12)
    fields = {"printer_id": printer["id"], "profile_id": str(plan["id"]), "start": "true", "wait_for_idle": "true"}
    header = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()
    )
    header += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="interrupted.gcode"\r\n'
               'Content-Type: application/octet-stream\r\n\r\n').encode()
    line = b"; GRE-448 upload proof\nG1 X1 Y1 F1200\n"
    content = (line * (FILE_BYTES // len(line) + 1))[:FILE_BYTES]
    digest = hashlib.sha256(content).hexdigest()
    body = header + content + f"\r\n--{boundary}--\r\n".encode()
    item = api.request("POST", "/api/v1/printer-send-queue", body,
                       f"multipart/form-data; boundary={boundary}")["item"]
    require(item["state"] == "queued", "public multipart route did not queue the upload")
    artifact = Path(item["artifact_path"])
    require(artifact.stat().st_size == FILE_BYTES and sha256(artifact) == digest, "public staging changed G-code")
    return item, digest


def run_case(node, root, evidence, cause, negative=False):
    evidence.mkdir()
    data = evidence / "data"
    data.mkdir(mode=0o700)
    receipt = {"cause": cause, "negative": negative, "data_dir": str(data)}
    with MoonrakerPeer(evidence) as peer, (data / "printpartner.lock").open("w+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with backend(node, root, data, lock, evidence / "before") as api:
            item, digest = stage_upload(api, peer)
            receipt.update(item_id=item["id"], artifact_path=item["artifact_path"], artifact_sha256=digest)
            staged = sqlite_queue(data, evidence / "sqlite-staged.json")
            require(staged == item, "public staging and SQLite disagree")
            dispatched = api.request("POST", "/api/v1/printer-send-queue/drain", {})["results"]
            require(len(dispatched) == 1 and dispatched[0]["item_id"] == item["id"] and "job_id" in dispatched[0],
                    "real drain did not start one upload job")
            job_id = dispatched[0]["job_id"]
            receipt["original_job_id"] = job_id
            peer.wait_uploads(1)
            running = api.request("GET", f"/api/v1/jobs/{job_id}")
            require(running["status"] == "running", "upload job finished before interruption")
            sending = sqlite_queue(data, evidence / "sqlite-sending.json")
            require(sending["state"] == "sending" and sending["upload_job_id"] == job_id,
                    "SQLite did not persist sending state and job id before interruption")
            require(len(peer.snapshot()) == 1 and api.child.poll() is None, "upload was not live before interruption")
            receipt["old_pid"] = api.child.pid
            api.stop(cause)
        interrupted = sqlite_queue(data, evidence / "sqlite-after-stop.json")
        require(interrupted["state"] == ("sending" if cause == "sigkill" else "error"),
                "interruption did not preserve the expected crash or EOF state")
        with backend(node, root, data, lock, evidence / "after") as api:
            require(api.child.pid != receipt["old_pid"] and lifecycle.pid_absent(receipt["old_pid"])
                    and lifecycle.group_absent(receipt["old_pid"]), "old backend survived restart")
            recovered = sqlite_queue(data, evidence / "sqlite-startup-recovered.json")
            require(recovered["state"] == "error" and recovered["error"] == UNKNOWN_OUTCOME,
                    "startup did not persist unknown-outcome error")
            require(api.request("GET", "/api/v1/printer-send-queue")["items"] == [recovered],
                    "HTTP queue recovery and SQLite disagree")
            api.request("GET", f"/api/v1/jobs/{job_id}", status=404)
            drains = [api.request("POST", "/api/v1/printer-send-queue/drain", {}) for _ in range(4)]
            if negative:
                peer.wait_uploads(2)
            jobs = api.request("GET", "/api/v1/jobs")["jobs"]
            final = sqlite_queue(data, evidence / "sqlite-after-drains.json")
            receipt.update(recovered=recovered, after_drains=final, drains=drains, restarted_jobs=jobs,
                           uploads=peer.snapshot(), new_pid=api.child.pid)
            write_json(evidence / "receipt.json", receipt)
            require(len(receipt["uploads"]) == 1, NETWORK_FAILURE)
            require(drains == [{"results": []}] * 4, "recovery admitted another drain job")
            require(jobs == [], "restart created a second job")
            require(final == recovered and final["id"] == item["id"] and final["upload_job_id"] == job_id,
                    "drains changed the original queue item or job id")
            artifact = Path(item["artifact_path"])
            require(artifact.is_file() and artifact.stat().st_size == FILE_BYTES and sha256(artifact) == digest,
                    "interrupted upload artifact was not retained unchanged")
            receipt["artifact_retained"] = True
            api.stop("eof")
    for phase in ("before", "after"):
        cleanup = json.loads((evidence / phase / "guard-cleanup.json").read_text())
        require(not cleanup["external_sigkill"], "positive case required fallback process cleanup")
    receipt["cleanup_verified"] = True
    write_json(evidence / "receipt.json", receipt)
    print(json.dumps({"case": str(evidence), "cause": cause, "uploads": len(receipt["uploads"]),
                      "job_id": job_id, "artifact_retained": True, "cleanup_verified": True}), flush=True)


def negative_copy(evidence):
    stage = evidence / "stage"
    stage.mkdir()
    shutil.copytree(ROOT / "web", stage / "web", symlinks=True)
    for path in (stage / "web").rglob("*"):
        if path.is_symlink():
            require(path.resolve().is_relative_to(stage), f"private copy contains an escaping symlink: {path}")
    policy = stage / "web/apps/server/dist/current/services/printer-send-queue.js"
    original = policy.read_text()
    needle = 'item.state === "queued" && (printerId === undefined || item.printer_id === printerId)'
    require(original.count(needle) == 1, "built drain selector changed; review the negative mutation")
    replacement = '(item.state === "queued" || item.state === "error") && (printerId === undefined || item.printer_id === printerId)'
    policy.write_text(original.replace(needle, replacement))
    write_json(evidence / "negative-mutation.json", {
        "package_root": str(stage), "policy": str(policy.resolve()), "before": needle, "after": replacement,
        "original_sha256": hashlib.sha256(original.encode()).hexdigest(), "mutated_sha256": sha256(policy),
        "shared_source_modified": False,
    })
    return stage


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
    require((ROOT / "web/apps/server/dist/current/desktop.js").is_file(), "build web before running this proof")
    args.evidence = args.evidence.resolve()
    args.evidence.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="run-", dir=args.evidence))
    print(f"Evidence: {evidence}", flush=True)
    measured = measured_artifacts(ROOT)
    write_json(evidence / "artifact-files.json", measured)
    write_json(evidence / "artifact-identity.json", {
        "node": str(node), "node_identity": node_identity, "node_sha256": sha256(node),
        "entry": str((ROOT / "web/apps/server/dist/current/desktop.js").resolve()),
        "entry_sha256": sha256(ROOT / "web/apps/server/dist/current/desktop.js"),
        "observer_sha256": sha256(lifecycle.OBSERVER), "measured_files": len(measured),
        "proof_class": "headless_unsigned_built_backend", "release_manifest_verified": False,
    })
    try:
        for cause in ("sigkill", "eof"):
            run_case(node, ROOT, evidence / f"baseline-{cause}", cause)
        if args.negative_control:
            stage = negative_copy(evidence)
            negative = evidence / "negative"
            try:
                run_case(node, stage, negative, "sigkill", negative=True)
            except AssertionError as error:
                require(str(error) == NETWORK_FAILURE, f"wrong negative failure: {error}")
                receipt = json.loads((negative / "receipt.json").read_text())
                require(len(receipt["uploads"]) == 2, "negative did not observe a second real multipart upload")
                require(len(receipt["restarted_jobs"]) == 1 and
                        receipt["after_drains"]["upload_job_id"] != receipt["original_job_id"],
                        "negative did not create a real second job")
                cleanup = json.loads((negative / "after/guard-cleanup.json").read_text())
                require(cleanup["pid_absent"] and cleanup["group_absent"], "negative child cleanup failed")
                write_json(evidence / "negative-control.json", {
                    "expected_failure": str(error), "network_uploads": 2, "second_job_created": True,
                    "cleanup": cleanup, "isolated_package_root": str(stage),
                })
                print(f"EXPECTED FAILURE: {error}; actual network uploads=2", flush=True)
            else:
                raise AssertionError("negative control unexpectedly passed")
            for cause in ("sigkill", "eof"):
                run_case(node, ROOT, evidence / f"restored-{cause}", cause)
    finally:
        unchanged = measured_artifacts(ROOT) == measured
        write_json(evidence / "artifact-unchanged.json", {"unchanged": unchanged, "measured_files": len(measured)})
        require(unchanged, "shared production source, built artifacts or dependencies changed during proof")
    print("PASS: built backend interrupted uploads retain unknown outcome without automatic resend", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(143))
    main()
