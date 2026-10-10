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
        assert select.select([runtime.stdout], [], [], 40)[0]
        origin = runtime.stdout.readline().strip()
        assert origin.startswith("http://127.0.0.1:")
        marker = json.loads((fixture / "data/.desktop-owner.json").read_text())
        sockets = list(Path(marker["runtime_dir"]).glob("*.sock"))
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
            assert b"already owned" in child.stderr or b"owned by the desktop runtime" in child.stderr, (entry, child.stderr[:200])
        child_pid = int(subprocess.check_output(["ps", "--no-headers", "-o", "pid", "--ppid", str(runtime.pid)], text=True).strip())
        child_environment = Path(f"/proc/{child_pid}/environ").read_bytes().split(b"\0")
        for name in (b"NODE_OPTIONS", b"NODE_PATH", b"PP_PARENT_ONLY_SECRET"):
            assert not any(entry.startswith(name + b"=") for entry in child_environment), name
        descendant = subprocess.Popen(["sleep", "120"], process_group=child_pid)
        os.kill(runtime.pid, signal.SIGKILL)
        runtime.wait(timeout=5)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            status = Path(f"/proc/{child_pid}/stat")
            child_dead = not status.exists() or status.read_text().split()[2] == "Z"
            if child_dead and descendant.poll() is not None and not (fixture / "data/.desktop-owner.json").exists():
                break
            time.sleep(.05)
        assert child_dead, "Node survived parent death"
        assert descendant.poll() is not None, "descendant survived parent death"
        assert not (fixture / "data/.desktop-owner.json").exists(), "ownership marker survived parent death"
        import fcntl
        with (fixture / "data/.desktop.lock").open("rb") as lock:
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
        print(json.dumps({"proof_class": "headless_unsigned", "case": "parent_death_and_private_boundary", "fixture": str(fixture),
                          "parent_pid": runtime.pid, "child_pid": child_pid, "descendant_pid": descendant.pid,
                          "direct_uds_denied": True, "forged_principal_denied": True, "standalone_writers_denied": 3,
                          "child_terminated": child_dead, "descendant_reaped": descendant.poll() is not None, "lock_reacquired": True,
                          "bootstrap_absent_from_logs": True, "parent_environment_injection_denied": True}))
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
