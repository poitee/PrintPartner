#!/usr/bin/env python3
"""Build, drive and stop an isolated Rust gateway; stdout is the proof.

Modes: `verify` (default) runs the full proof. `launch` builds, starts pp-server
on loopback, prints `PP_SERVER_URL=...` and stays up until SIGTERM, SIGINT or SIGHUP,
then stops it cleanly.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


STOP_SIGNALS = frozenset({signal.SIGTERM, signal.SIGINT, signal.SIGHUP})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Stop(Exception):
    """Raised from a SIGTERM/SIGINT/SIGHUP handler so launch mode can clean up."""


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def ignore_signals():
    # Once cleanup starts, further signals must not interrupt it.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
    try:
        for signum in STOP_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def begin_stop(name):
    ignore_signals()
    return Stop(name)


# While held, a signal is recorded and raised only after release_signals(), so
# pp-server is never stopped before it is recorded or before its origin is printed.
held = {"active": False, "pending": None}


def stop_on_signal(signum, _frame):
    name = signal.Signals(signum).name
    if held["active"]:
        held["pending"] = name
        return
    raise begin_stop(name)


def install_stop_handlers():
    # Handler installation is atomic; preserve unrelated masks inherited from the caller.
    signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
    for signum in STOP_SIGNALS:
        signal.signal(signum, stop_on_signal)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, STOP_SIGNALS)


def release_signals():
    held["active"] = False
    if held["pending"] is not None:
        raise begin_stop(held["pending"])


def stop_group(process, grace=5):
    # Build workers are already spawned, so blocking cannot leak a mask into them.
    # Deliver any additional stop only after the whole group has been cleaned up.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
    try:
        _stop_group(process, grace)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _stop_group(process, grace):
    # The build runs in its own session, so its pid is also its process group id. Terminate the
    # whole group (npm, node, rustc, ...), escalate to SIGKILL after `grace` seconds, and return
    # only once no live member is left, so a replacement launch cannot overlap leftover writers.
    group = process.pid

    def signal_group(signum):
        try:
            os.killpg(group, signum)
        except ProcessLookupError:
            pass

    def group_gone():
        process.poll()  # reaps the leader if it has exited; its descendants keep the group alive
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return True
        # An orphan can remain as a zombie until PID 1 reaps it. Such a member cannot
        # execute or write files; killpg(0) alone cannot distinguish it from a live worker.
        try:
            members = subprocess.check_output(["ps", "-axo", "pgid=,stat="], text=True, timeout=1)
            for line in members.splitlines():
                fields = line.split()
                if len(fields) == 2 and int(fields[0]) == group and not fields[1].startswith("Z"):
                    return False
        except (OSError, subprocess.SubprocessError, ValueError):
            # Failed inspection cannot establish that workers exited. Keep waiting and
            # escalate normally rather than abandoning cleanup before SIGKILL.
            return False
        return True

    def wait_gone(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if group_gone():
                return True
            time.sleep(0.05)
        return group_gone()

    signal_group(signal.SIGTERM)
    if not wait_gone(grace):
        signal_group(signal.SIGKILL)
        check(wait_gone(5), f"build process group {group} survived SIGKILL")
    if process.stdout is not None:
        process.stdout.close()


def run(root, *args, env=None, stdout=None):
    print("BUILD:", " ".join(args), flush=True)
    # Defer launch's signal exception until the child is recorded. Keeping the OS mask
    # unchanged lets build workers handle SIGTERM normally rather than inherit blocked signals.
    was_held = held["active"]
    held["active"] = True
    process = None
    try:
        process = subprocess.Popen(args, cwd=root, env=env, stdout=stdout, text=True, start_new_session=True)
        if not was_held:
            release_signals()
        output, _ = process.communicate(timeout=600)
    finally:
        # Even successful/nonzero leaders can leave background workers behind. Finish each
        # group before another build starts, and defer launch signals during this teardown.
        held["active"] = True
        try:
            if process is not None:
                stop_group(process)
        finally:
            held["active"] = was_held
        if not was_held:
            release_signals()
    if process.returncode:
        if output:
            print(output, end="", flush=True)
        raise subprocess.CalledProcessError(process.returncode, args, output=output)
    return subprocess.CompletedProcess(args, process.returncode, output, None)


def checkout(root):
    if not (root / "rust").is_dir():
        raise SystemExit("rust/ not found; check out the desktop chain")
    check((root / "rust/crates/pp-server/Cargo.toml").is_file(), "Rust pp-server checkout required")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=15).strip()
    print(f"Rust verification checkout: {root}\nCommit: {commit}", flush=True)
    node_path = shutil.which("node")
    check(node_path is not None, "node not found; install the Node version documented in rust/README.md")
    return commit, str(Path(node_path).resolve())


def build(root, node, commit):
    run(root, "npm", "--prefix", "web", "ci")
    run(root, "npm", "--prefix", "web", "run", "build", env=dict(os.environ, VITE_PRINT_PARTNER_DESKTOP="1"))
    run(root, sys.executable, "rust/scripts/build-desktop-manifest.py", "--web", "web", "--node", node,
        "--output", "rust/bundle-manifest.json", "--commit", commit)
    build = run(root, "cargo", "build", "--manifest-path", "rust/Cargo.toml", "--locked", "-p", "pp-server",
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
    return binary


def start_server(binary, root, node, commit, fixture, errors, credentials=None, isolated=False):
    args = [str(binary), "--data", str(fixture / "data"), "--web", str(root / "web"),
            "--node", node, "--commit", commit]
    if credentials is not None:
        args += ["--test-credential-file", str(credentials)]
    # A new session keeps terminal Ctrl-C from reaching pp-server before its signal handlers exist.
    return subprocess.Popen(args, cwd=root, stdout=subprocess.PIPE, stderr=errors, text=True,
                            start_new_session=isolated)


def read_origin(process, errors):
    # Read only available bytes, so a silent server or an unterminated origin line
    # cannot postpone a held stop request until the full startup timeout.
    deadline = time.monotonic() + 60
    data = bytearray()
    while b"\n" not in data:
        if held["active"] and held["pending"] is not None:
            release_signals()
        remaining = deadline - time.monotonic()
        check(remaining > 0, "Rust startup timed out")
        if not select.select([process.stdout], [], [], min(0.1, remaining))[0]:
            continue
        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            break
        data.extend(chunk)
    # A stop arriving with the origin line stays pending: the caller has a running server
    # to stop and must still check its shutdown, so it honours the stop after this returns.
    origin = bytes(data).split(b"\n", 1)[0].decode().strip()
    if not origin:
        process.wait(timeout=5)
        errors.seek(0)
        raise RuntimeError(f"Rust startup failed (exit={process.returncode}): {errors.read().strip()}")
    parsed = urllib.parse.urlsplit(origin)
    check(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port,
          "Rust did not emit a loopback origin")
    return origin


def terminate(process):
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=25)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise RuntimeError("Rust shutdown timed out")


def verify_shutdown(process, fixture, runtime_dir):
    check(process.returncode == 0, f"Rust exited {process.returncode}")
    check(not (fixture / "data/.desktop-owner.json").exists(), "Owner marker survived")
    check(runtime_dir is None or not runtime_dir.exists(), "Private runtime directory survived")
    try:
        with (fixture / "data/.desktop.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except FileNotFoundError:
        raise RuntimeError("Rust shutdown verification failed: data lock file missing") from None


def verify(root):
    commit, node = checkout(root)
    binary = build(root, node, commit)
    with tempfile.TemporaryDirectory(prefix="pp-verify-rust-") as temporary:
        fixture = Path(temporary)
        credentials = fixture / "credentials.json"
        with (fixture / "server.stderr").open("w+") as errors:
            held["active"] = True
            process = start_server(binary, root, node, commit, fixture, errors, credentials)
            runtime_dir = None
            try:
                release_signals()
                origin = read_origin(process, errors)
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
                cleanup_stop = None
                try:
                    ignore_signals()
                except Stop as stop:
                    # The handler installed ignored handlers before raising. Finish cleanup
                    # before propagating cancellation, preserving any earlier proof failure.
                    cleanup_stop = stop
                held["active"] = False
                failed = sys.exc_info()[0] is not None
                try:
                    terminate(process)
                    credentials.unlink(missing_ok=True)
                except Exception as error:
                    if not failed:
                        raise
                    print(f"CLEANUP ERROR (original failure preserved): {error}", flush=True)
                finally:
                    process.stdout.close()
                    errors.seek(0)
                    print("SERVER STDERR:\n" + errors.read(), flush=True)
            if cleanup_stop is not None and not failed:
                raise cleanup_stop
            verify_shutdown(process, fixture, runtime_dir)
            print("STOP: exit=0; owner marker removed; private sockets removed; data lock reacquired", flush=True)
    print("PASS: Rust build, gateway endpoints, persisted Source and shutdown", flush=True)


def publish_credential(source, target):
    # Write a private temporary inode, then hard-link it to the target: link() refuses to clobber
    # a file that appeared after launch started, and the target only ever names a complete file.
    # The returned handle stays open to pin this inode, so its number cannot be reused.
    fd, temporary = tempfile.mkstemp(prefix=".pp-credential-", dir=target.parent)
    handle = os.fdopen(fd, "wb")
    try:
        try:
            handle.write(source.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
            os.link(temporary, target)
        finally:
            os.unlink(temporary)
    except BaseException:
        handle.close()
        raise
    return handle


def unpublish_credential(target, handle):
    # Move the entry into a fresh private directory first: its name is unpredictable and
    # empty, so the rename cannot overwrite anything and only this launch touches it.
    if handle is None:
        return
    try:
        try:
            vault = Path(tempfile.mkdtemp(prefix=".pp-credential-", dir=target.parent))
        except FileNotFoundError:
            # The caller removed the parent after consuming the credential, so nothing is left to remove.
            return
        entry = vault / "entry"
        try:
            os.rename(target, entry)
        except FileNotFoundError:
            vault.rmdir()
            return
        except BaseException:
            vault.rmdir()
            raise
        status = entry.lstat()
        owned = os.fstat(handle.fileno())
        if (status.st_dev, status.st_ino) == (owned.st_dev, owned.st_ino):
            entry.unlink()
            vault.rmdir()
            return
        # Foreign entries are never deleted. Only a regular file is restored, and never over
        # whatever now occupies the path; anything else stays in the vault with a warning.
        if not stat.S_ISREG(status.st_mode):
            print(f"WARNING: foreign non-file entry kept at {entry}", flush=True)
            return
        try:
            os.link(entry, target)
        except OSError as error:
            print(f"WARNING: foreign file kept at {entry} ({error})", flush=True)
            return
        entry.unlink()
        vault.rmdir()
    finally:
        handle.close()


def launch(root, credentials):
    # Fast refusal before a long build; publish_credential() is the authoritative check.
    if credentials is not None and (credentials.exists() or credentials.is_symlink()):
        raise SystemExit(f"credential file already exists: {credentials}")
    try:
        install_stop_handlers()
        commit, node = checkout(root)
        binary = build(root, node, commit)
        serve(binary, root, node, commit, credentials)
    except Stop as stop:
        print(f"STOP: {stop} received before pp-server started", flush=True)


def serve(binary, root, node, commit, credentials):
    with tempfile.TemporaryDirectory(prefix="pp-launch-rust-") as temporary:
        fixture = Path(temporary)
        runtime_dir = None
        published = None
        origin = None
        with (fixture / "server.stderr").open("w+") as errors:
            # pp-server writes its bootstrap into the private fixture; launch publishes it below.
            internal = fixture / "bootstrap.json" if credentials is not None else None
            held["active"] = True
            process = start_server(binary, root, node, commit, fixture, errors, internal, isolated=True)
            try:
                origin = read_origin(process, errors)
                marker = fixture / "data/.desktop-owner.json"
                runtime_dir = Path(json.loads(marker.read_text())["runtime_dir"])
                if held["pending"] is not None:
                    # Stopped once ready: skip publishing and stop below with full shutdown checks.
                    release_signals()
                if credentials is not None:
                    published = publish_credential(internal, credentials)
                port = urllib.parse.urlsplit(origin).port
                print(f"PP_SERVER_URL={origin} PP_SERVER_PORT={port} PP_SERVER_PID={process.pid}", flush=True)
                release_signals()
                process.wait()
                if process.returncode != 0:
                    raise RuntimeError(f"pp-server exited without a stop request (exit={process.returncode})")
                print("STOP: pp-server exited cleanly; checking shutdown", flush=True)
            except Stop as stop:
                print(f"STOP: {stop} received; stopping pp-server", flush=True)
            finally:
                try:
                    ignore_signals()
                except Stop:
                    # A stop at cleanup entry must still remove credentials and check shutdown.
                    pass
                held["active"] = False
                try:
                    terminate(process)
                finally:
                    if credentials is not None:
                        unpublish_credential(credentials, published)
                    process.stdout.close()
                    errors.seek(0)
                    print("SERVER STDERR:\n" + errors.read(), flush=True)
            if origin is None:
                # Cancellation before readiness need not have created the data lock yet.
                print("STOP: exit=0; pp-server stopped before readiness", flush=True)
            else:
                verify_shutdown(process, fixture, runtime_dir)
                print("STOP: exit=0; owner marker removed; private sockets removed; data lock reacquired", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=["verify", "launch"], default="verify")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--credential-file", type=Path,
                        help="launch only: pp-server writes the one-use bootstrap credential here")
    args = parser.parse_args()
    if args.credential_file is not None and args.mode != "launch":
        parser.error("--credential-file applies only to launch")
    root = args.repo.resolve()
    if args.mode == "launch":
        # Resolve the directory only: a symlink at the final component is an existing entry to refuse.
        credentials = args.credential_file.parent.resolve() / args.credential_file.name if args.credential_file else None
        launch(root, credentials)
    else:
        # Cancelled proofs remain nonzero, after their owned processes have been cleaned up.
        install_stop_handlers()
        verify(root)


if __name__ == "__main__":
    main()
