#!/usr/bin/env python3
"""Proof for `verify.py launch`: start, reach /health, SIGTERM, clean exit."""
import contextlib
import json
import os
from pathlib import Path
import queue
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
