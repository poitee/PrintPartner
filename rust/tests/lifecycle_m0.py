import http.client
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
COMMIT = json.loads((ROOT / "rust/bundle-manifest.json").read_text())["commit"]
SERVER_STARTUP_SECONDS = 40


def main():
    fixture = Path(tempfile.mkdtemp(prefix="pp-lifecycle-m0-"))
    credentials = fixture / "credentials.json"
    runtime = subprocess.Popen([str(ROOT / "rust/target/debug/pp-server"), "--data", str(fixture / "data"),
                               "--web", str(ROOT / "web"), "--node", "/usr/bin/node", "--commit", COMMIT,
                               "--test-credential-file", str(credentials)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               env=dict(os.environ, NODE_OPTIONS="--require=/nonexistent-pp-parent-injection.cjs",
                                        NODE_PATH="/nonexistent-pp-parent-modules", PP_PARENT_ONLY_SECRET="synthetic-test-value"))
    descendant = None
    try:
        assert select.select([runtime.stdout], [], [], SERVER_STARTUP_SECONDS)[0]
        origin = runtime.stdout.readline().strip()
        assert origin.startswith("http://127.0.0.1:")
        receipt = json.loads(credentials.read_text())
        reservation = fixture / "data/.desktop-lease"
        reservation_bytes = reservation.read_bytes()
        reservation_inode = reservation.stat().st_ino
        lock_inode = (fixture / "data/printpartner.lock").stat().st_ino
        sockets = list(Path(receipt["runtime_dir"]).glob("*.sock"))
        assert len(sockets) == 1
        assert sockets[0].stat().st_mode & 0o777 == 0o600
        assert sockets[0].parent.stat().st_mode & 0o777 == 0o700
        def direct(headers):
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.connect(str(sockets[0]))
            connection.sendall(("GET /health HTTP/1.1\r\nHost: desktop-compat\r\nConnection: close\r\n" + headers + "\r\n").encode())
            response = b""
            while chunk := connection.recv(4096):
                response += chunk
            connection.close()
            assert response.startswith(b"HTTP/1.1 401"), response[:100]
        direct("")
        direct("x-pp-principal: 7b7d\r\nx-pp-signature: " + "00" * 32 + "\r\n")
        for entry in ("index.js", "db/migrate.js", "mcp/stdio-server.js"):
            env = dict(os.environ, PRINT_PARTNER_DATA_DIR=str(fixture / "data"), HOST="127.0.0.1", PORT="0")
            child = subprocess.run(["/usr/bin/node", str(ROOT / "web/apps/server/dist/current" / entry)], env=env, cwd=ROOT / "web", capture_output=True, timeout=15)
            assert child.returncode != 0, entry
            assert b"already owned" in child.stderr or b"owned by the desktop runtime" in child.stderr or b"storage_lease_marker_invalid: Data directory lease is malformed or unreadable" in child.stderr, (entry, child.stderr[:200])
        child_pid = receipt["child_pid"]
        assert int(Path(f"/proc/{child_pid}/stat").read_text().split()[3]) == runtime.pid
        assert child_pid != runtime.pid
        child_environment = Path(f"/proc/{child_pid}/environ").read_bytes().split(b"\0")
        for name in (b"NODE_OPTIONS", b"NODE_PATH", b"PP_PARENT_ONLY_SECRET"):
            assert not any(entry.startswith(name + b"=") for entry in child_environment), name
        descendant = subprocess.Popen(["sleep", "120"], process_group=child_pid)
        parent_pid = runtime.pid
        os.kill(runtime.pid, signal.SIGKILL)
        runtime.wait(timeout=5)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            status = Path(f"/proc/{child_pid}/stat")
            child_dead = not status.exists() or status.read_text().split()[2] == "Z"
            if child_dead and descendant.poll() is not None:
                break
            time.sleep(.05)
        assert child_dead, "Node survived parent death"
        assert descendant.poll() is not None, "descendant survived parent death"
        assert reservation.read_bytes() == reservation_bytes, "crash altered the compatibility reservation"
        import fcntl
        with (fixture / "data/printpartner.lock").open("rb") as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    assert time.monotonic() < deadline, "OS lock outlived terminated descendants"
                    time.sleep(.05)
            fcntl.flock(lock, fcntl.LOCK_UN)
        logs = b"".join(path.read_bytes() for path in (fixture / "data/logs").glob("*.jsonl"))
        token = json.loads(credentials.read_text())["bootstrap_url"].split("token=", 1)[1].encode()
        assert token not in logs
        assert b"x-pp-principal" not in logs and b"x-pp-signature" not in logs
        credentials.unlink()
        runtime = subprocess.Popen(runtime.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert select.select([runtime.stdout], [], [], SERVER_STARTUP_SECONDS)[0], "recovery readiness timed out"
        recovered_origin = runtime.stdout.readline().strip()
        assert recovered_origin == origin, "recovery changed the persisted origin"
        recovered = json.loads(credentials.read_text())
        assert recovered["child_pid"] != child_pid
        assert reservation.read_bytes() == reservation_bytes and reservation.stat().st_ino == reservation_inode
        assert (fixture / "data/printpartner.lock").stat().st_ino == lock_inode
        with (fixture / "data/printpartner.lock").open("rb") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError("recovered runtime did not hold the OS lock")
            except BlockingIOError:
                pass
        runtime.terminate()
        _, stderr = runtime.communicate(timeout=17)
        assert runtime.returncode == 0, stderr
        assert not reservation.exists(), "compatibility reservation survived clean recovery shutdown"
        print(json.dumps({"proof_class": "headless_unsigned", "case": "parent_death_and_private_boundary", "fixture": str(fixture),
                          "parent_pid": parent_pid, "child_pid": child_pid, "descendant_pid": descendant.pid,
                          "direct_uds_denied": True, "forged_principal_denied": True, "standalone_writers_denied": 3,
                          "child_terminated": child_dead, "descendant_reaped": descendant.poll() is not None, "lock_reacquired": True,
                          "bootstrap_absent_from_logs": True, "parent_environment_injection_denied": True,
                          "crash_marker_preserved": True, "recovery_shutdown_clean": True}))
    finally:
        if runtime.poll() is None:
            runtime.terminate()
            runtime.wait(timeout=17)
        if descendant and descendant.poll() is None:
            descendant.kill()
            descendant.wait()
        credentials.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
