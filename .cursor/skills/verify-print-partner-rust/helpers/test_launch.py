#!/usr/bin/env python3
"""Proof for `verify.py launch`: start, reach /health, SIGTERM, clean exit."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

HELPER = Path(__file__).resolve().with_name("verify.py")
# git rev-parse (15s), four build steps (600s each), server startup (60s), plus margin.
BUILD_TIMEOUT = 15 + 4 * 600 + 60 + 60


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_until_gone(pid, timeout):
    deadline = time.monotonic() + timeout
    while process_alive(pid):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)
    return True


def write_executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def make_fixture_repo(root):
    # Just enough checkout for `verify.py launch` to pass its preflight; the build tools are stubs.
    (root / "rust/crates/pp-server").mkdir(parents=True)
    (root / "rust/crates/pp-server/Cargo.toml").write_text('[package]\nname = "pp-server"\n')
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                    "commit", "-q", "--allow-empty", "-m", "fixture"], cwd=root, check=True)
    return root


def next_line(lines, prefix, timeout):
    deadline = time.monotonic() + timeout
    while True:
        try:
            line = lines.get(timeout=max(deadline - time.monotonic(), 0))
        except queue.Empty:
            raise AssertionError(f"timed out waiting for {prefix}") from None
        if line is None:
            raise AssertionError(f"launch exited before printing {prefix}")
        if line.startswith(prefix):
            return line


class LaunchTest(unittest.TestCase):
    def test_launch_serves_health_and_stops_on_sigterm(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with tempfile.TemporaryDirectory(prefix="pp-launch-test-") as temporary:
            credentials = Path(temporary) / "credentials.json"
            process = subprocess.Popen(
                [sys.executable, str(HELPER), "launch", "--credential-file", str(credentials)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            lines = queue.Queue()
            transcript = []

            def pump():
                for line in process.stdout:
                    transcript.append(line)
                    lines.put(line)
                lines.put(None)

            pump_thread = threading.Thread(target=pump, daemon=True)
            pump_thread.start()
            child_pid = None
            try:
                fields = dict(token.split("=", 1) for token in
                              next_line(lines, "PP_SERVER_URL=", BUILD_TIMEOUT).split())
                origin = fields["PP_SERVER_URL"]
                parsed = urllib.parse.urlsplit(origin)
                self.assertEqual((parsed.scheme, parsed.hostname), ("http", "127.0.0.1"))
                self.assertEqual(int(fields["PP_SERVER_PORT"]), parsed.port)
                child_pid = int(fields["PP_SERVER_PID"])
                print(f"launch printed {origin} pid={child_pid}")

                deadline = time.monotonic() + 60
                while not credentials.exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                bootstrap = json.loads(credentials.read_text())["bootstrap_url"]
                self.assertTrue(bootstrap.startswith(origin + "/__desktop/bootstrap?"))
                try:
                    opener.open(urllib.request.Request(origin + bootstrap[len(origin):],
                                                       headers={"Origin": origin}), timeout=30)
                except urllib.error.HTTPError as error:
                    self.assertEqual(error.code, 303)
                    cookie = error.headers["Set-Cookie"].split(";", 1)[0]
                    error.close()
                credentials.unlink()

                with self.assertRaises(urllib.error.HTTPError) as denied:
                    opener.open(urllib.request.Request(origin + "/health", headers={"Origin": origin}), timeout=30)
                self.assertEqual(denied.exception.code, 401)
                denied.exception.close()
                with opener.open(urllib.request.Request(origin + "/health",
                                                        headers={"Origin": origin, "Cookie": cookie}),
                                 timeout=30) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIs(json.loads(response.read())["ok"], True)
                print("GET /health -> 200 {\"ok\": true}")

                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=60), 0)
                pump_thread.join(timeout=30)
                output = "".join(transcript)
                self.assertIn("STOP: SIGTERM received", output)
                self.assertIn("STOP: exit=0;", output)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                print("SIGTERM -> exit 0; pp-server pid gone")
            finally:
                # Failure cleanup: stop the launcher gracefully so it terminates pp-server, then reap any survivor.
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
                if child_pid is not None:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(child_pid, signal.SIGKILL)
                pump_thread.join(timeout=30)
                process.stdout.close()


def load_verify():
    spec = importlib.util.spec_from_file_location("verify", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CredentialFileTest(unittest.TestCase):
    def test_existing_symlink_is_refused_not_followed(self):
        verify = load_verify()
        with tempfile.TemporaryDirectory(prefix="pp-credential-test-") as temporary:
            temp = Path(temporary)
            source = temp / "bootstrap.json"
            source.write_text("{}")
            elsewhere = temp / "elsewhere.json"
            target = temp / "credentials.json"
            os.symlink(elsewhere, target)  # dangling: the destination does not exist
            with self.assertRaises(FileExistsError):
                verify.publish_credential(source, target)
            self.assertFalse(elsewhere.exists())
            # Exercise main's path handling too: resolving the final component would bypass refusal.
            result = subprocess.run([sys.executable, str(HELPER), "launch", "--repo", str(temp),
                                     "--credential-file", str(target)], capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("credential file already exists", result.stderr)
            self.assertTrue(target.is_symlink())
            self.assertFalse(elsewhere.exists())

    def test_removed_parent_directory_is_a_noop_on_shutdown(self):
        verify = load_verify()
        with tempfile.TemporaryDirectory(prefix="pp-credential-test-") as temporary:
            source = Path(temporary) / "bootstrap.json"
            source.write_text("{}")
            parent = Path(temporary) / "consumer"
            parent.mkdir()
            handle = verify.publish_credential(source, parent / "credentials.json")
            shutil.rmtree(parent)  # the consumer removed its directory after reading the credential
            verify.unpublish_credential(parent / "credentials.json", handle)
            self.assertFalse(parent.exists())


class BuildGroupTest(unittest.TestCase):
    def test_completed_build_reaps_background_children(self):
        verify = load_verify()
        with tempfile.TemporaryDirectory(prefix="pp-build-group-test-") as temporary:
            root = Path(temporary)
            for status in (0, 1):
                with self.subTest(exit_status=status):
                    pidfile = root / "child.pid"
                    command = f'sleep 600 & echo $! > "{pidfile}"; exit {status}'
                    if status:
                        with self.assertRaises(subprocess.CalledProcessError):
                            verify.run(root, "sh", "-c", command)
                    else:
                        verify.run(root, "sh", "-c", command)
                    self.assertFalse(process_alive(int(pidfile.read_text())))

    def test_repeated_sigint_cannot_interrupt_group_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="pp-build-group-test-") as temporary:
            root = Path(temporary)
            pidfile = root / "child.pid"
            worker = ("import os, signal, time; from pathlib import Path; "
                      "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"Path({str(pidfile)!r}).write_text(str(os.getpid())); time.sleep(600)")
            driver = (f"import sys; sys.path.insert(0, {str(HELPER.parent)!r}); import verify; "
                      f"verify.run({str(root)!r}, sys.executable, '-c', {worker!r})")
            process = subprocess.Popen([sys.executable, "-c", driver],
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            child_pid = None
            try:
                deadline = time.monotonic() + 15
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(pidfile.exists())
                child_pid = int(pidfile.read_text())
                process.send_signal(signal.SIGINT)
                time.sleep(0.3)
                process.send_signal(signal.SIGINT)
                output, _ = process.communicate(timeout=20)
                self.assertNotEqual(process.returncode, 0, output)
                self.assertTrue(wait_until_gone(child_pid, 5), output)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
                if child_pid is not None:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(child_pid, signal.SIGKILL)


class StopDuringBuildTest(unittest.TestCase):
    def test_stop_during_build_leaves_no_build_children(self):
        self.assert_stop_leaves_no_children(signal.SIGTERM)

    def test_sigint_during_build_leaves_no_build_children(self):
        self.assert_stop_leaves_no_children(signal.SIGINT)

    def assert_stop_leaves_no_children(self, stop_signal):
        with tempfile.TemporaryDirectory(prefix="pp-launch-build-test-") as temporary:
            temp = Path(temporary)
            root = make_fixture_repo(temp / "repo")
            bin_dir = temp / "bin"
            bin_dir.mkdir()
            write_executable(bin_dir / "node", "#!/bin/sh\nexit 0\n")
            # Stands in for `npm ci`: a background grandchild in the build's process tree, then a wait.
            write_executable(bin_dir / "npm", '#!/bin/sh\nsleep 600 &\necho $! > "$PP_TEST_PIDFILE.tmp"\n'
                                              'mv "$PP_TEST_PIDFILE.tmp" "$PP_TEST_PIDFILE"\nwait\n')
            pidfile = temp / "child.pid"
            env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                       PP_TEST_PIDFILE=str(pidfile))
            # Output goes to a file, not a pipe: a surviving build child must not keep a pipe open.
            log = temp / "launch.log"
            with log.open("w") as stdout:
                process = subprocess.Popen([sys.executable, str(HELPER), "launch", "--repo", str(root)],
                                           env=env, stdout=stdout, stderr=subprocess.STDOUT, text=True)
            child_pid = None
            try:
                deadline = time.monotonic() + 60
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(pidfile.exists(), "fake npm never started its child")
                child_pid = int(pidfile.read_text())
                self.assertTrue(process_alive(child_pid), "build child should be running before the stop")

                process.send_signal(stop_signal)
                self.assertEqual(process.wait(timeout=60), 0)
                output = log.read_text()
                self.assertIn("BUILD: npm --prefix web ci", output)
                self.assertIn(f"STOP: {stop_signal.name} received before pp-server started", output)
                self.assertTrue(wait_until_gone(child_pid, 5), "build child outlived the launcher")
                print(f"{stop_signal.name} during build -> exit 0; build process tree gone")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
                if child_pid is not None and process_alive(child_pid):
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(child_pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
