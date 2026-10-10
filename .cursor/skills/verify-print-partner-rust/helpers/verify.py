#!/usr/bin/env python3
"""Build, drive and stop an isolated Rust gateway; stdout is the proof."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    root = parser.parse_args().repo.resolve()
    if not (root / "rust").is_dir():
        raise SystemExit("rust/ not found; check out the desktop chain")
    check((root / "rust/crates/pp-server/Cargo.toml").is_file(), "Rust pp-server checkout required")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=15).strip()
    print(f"Rust verification checkout: {root}\nCommit: {commit}", flush=True)
    node_path = shutil.which("node")
    check(node_path is not None, "node not found; install the Node version documented in rust/README.md")
    node = str(Path(node_path).resolve())

    def run(*args, env=None, stdout=None):
        print("BUILD:", " ".join(args), flush=True)
        try:
            return subprocess.run(args, cwd=root, env=env, stdout=stdout, text=True, check=True, timeout=600)
        except subprocess.CalledProcessError as error:
            if error.stdout:
                print(error.stdout, end="", flush=True)
            raise

    run("npm", "--prefix", "web", "ci")
    run("npm", "--prefix", "web", "run", "build", env=dict(os.environ, VITE_PRINT_PARTNER_DESKTOP="1"))
    run(sys.executable, "rust/scripts/build-desktop-manifest.py", "--web", "web", "--node", node,
        "--output", "rust/bundle-manifest.json", "--commit", commit)
    build = run("cargo", "build", "--manifest-path", "rust/Cargo.toml", "--locked", "-p", "pp-server",
                "--message-format=json", stdout=subprocess.PIPE)
    binary = None
    for line in build.stdout.splitlines():
        artifact = json.loads(line)
        if artifact["reason"] == "compiler-message":
            print(artifact["message"].get("rendered", ""), end="", flush=True)
        if (artifact["reason"] == "compiler-artifact" and artifact["target"]["name"] == "pp-server"
                and artifact.get("executable")):
            binary = Path(artifact["executable"])
    check(binary is not None, "Cargo did not report a pp-server executable")
    print(f"EXECUTABLE: {binary}", flush=True)
    with tempfile.TemporaryDirectory(prefix="pp-verify-rust-") as temporary:
        fixture = Path(temporary)
        credentials = fixture / "credentials.json"
        with (fixture / "server.stderr").open("w+") as errors:
            process = subprocess.Popen([
                str(binary), "--data", str(fixture / "data"), "--web", str(root / "web"),
                "--node", node, "--commit", commit, "--test-credential-file", str(credentials),
            ], cwd=root, stdout=subprocess.PIPE, stderr=errors, text=True)
            runtime_dir = None
            try:
                check(select.select([process.stdout], [], [], 60)[0], "Rust startup timed out")
                origin = process.stdout.readline().strip()
                if not origin:
                    process.wait(timeout=5)
                    errors.seek(0)
                    raise RuntimeError(f"Rust startup failed (exit={process.returncode}): {errors.read().strip()}")
                parsed = urllib.parse.urlsplit(origin)
                check(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port,
                      "Rust did not emit a loopback origin")
                print(f"START: pid={process.pid} origin={origin}", flush=True)
                marker = fixture / "data/.desktop-owner.json"
                runtime_dir = Path(json.loads(marker.read_text())["runtime_dir"])
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                cookie = None

                def request(path, expected=200, method="GET", body=None, headers=None, secret=False):
                    values = {"Origin": origin, **(headers or {})}
                    if cookie:
                        values["Cookie"] = cookie
                    if body is not None:
                        body = json.dumps(body).encode()
                        values["Content-Type"] = "application/json"
                    req = urllib.request.Request(origin + path, data=body, method=method, headers=values)
                    try:
                        response = opener.open(req, timeout=30)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        data = response.read()
                        if "json" in response.headers.get("Content-Type", ""):
                            data = json.loads(data)
                        shown = json.dumps(data) if not isinstance(data, bytes) else f"{len(data)} bytes"
                        print(f"HTTP {method} {path if not secret else '/__desktop/bootstrap [redacted]'}"
                              f" -> {response.status}: {shown}", flush=True)
                        check(response.status == expected, "Unexpected HTTP status")
                        return data, response.headers

                request("/health", expected=401)
                check(credentials.stat().st_mode & 0o777 == 0o600, "Credential file must be private")
                launch = json.loads(credentials.read_text())["bootstrap_url"]
                check(launch.startswith(origin + "/__desktop/bootstrap?"), "Unexpected bootstrap origin")
                _, headers = request(launch[len(origin):], expected=303, secret=True)
                cookie = headers["Set-Cookie"].split(";", 1)[0]
                credentials.unlink()
                health, _ = request("/health")
                check(health["ok"] is True, "Health not OK")
                state, _ = request("/__runtime")
                check(state["compat"]["state"] == "ready", "Compatibility server not ready")
                html, _ = request("/builds", headers={"Accept": "text/html"})
                check(b'<div id="root">' in html, "React document missing")
                source, _ = request("/sources", method="POST",
                                    body={"name": "Rust verification source", "source_kind": "local"})
                saved, _ = request(f'/sources/{source["id"]}')
                check(saved["id"] == source["id"] and saved["name"] == "Rust verification source",
                      "Source did not persist")
            finally:
                failed = sys.exc_info()[0] is not None
                try:
                    if process.poll() is None:
                        process.terminate()
                    try:
                        process.wait(timeout=25)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                        raise RuntimeError("Rust shutdown timed out")
                    credentials.unlink(missing_ok=True)
                except Exception as error:
                    if not failed:
                        raise
                    print(f"CLEANUP ERROR (original failure preserved): {error}", flush=True)
                finally:
                    process.stdout.close()
                    errors.seek(0)
                    print("SERVER STDERR:\n" + errors.read(), flush=True)
            check(process.returncode == 0, f"Rust exited {process.returncode}")
            check(not (fixture / "data/.desktop-owner.json").exists(), "Owner marker survived")
            check(runtime_dir is not None and not runtime_dir.exists(), "Private runtime directory survived")
            try:
                with (fixture / "data/.desktop.lock").open("rb") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except FileNotFoundError:
                raise RuntimeError("Rust shutdown verification failed: data lock file missing") from None
            print("STOP: exit=0; owner marker removed; private sockets removed; data lock reacquired", flush=True)
    print("PASS: Rust build, gateway endpoints, persisted Source and shutdown", flush=True)


if __name__ == "__main__":
    main()
