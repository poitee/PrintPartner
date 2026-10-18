"""Exercise delayed listener controls without building the backend."""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

from built_backend_listeners import CONTROLS


class DelayedListenerTiming(unittest.TestCase):
    def test_extra_unix_listener_waits_for_readiness(self):
        with tempfile.TemporaryDirectory(prefix="pp-time-") as directory:
            runtime = Path(directory).resolve()
            backend = runtime / "backend.sock"
            extra = runtime / "backend.sock.extra"
            preload = runtime / "control.mjs"
            preload.write_text(CONTROLS["extra_backend_unix_listener"])
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(backend))
                server.listen()
                child = subprocess.Popen(
                    [shutil.which("node"), "--import", preload.as_uri(), "-e",
                     "console.log('control loaded'); process.stdin.resume()"],
                    env={**os.environ, "PP_LISTENER_CONTROL_SOCKET": str(backend)},
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline(), "control loaded\n")
                    deadline = time.monotonic() + 1.2
                    while time.monotonic() < deadline:
                        self.assertIsNone(child.poll(), "Node control exited before readiness")
                        with socket.socket(socket.AF_UNIX) as probe:
                            self.assertNotEqual(probe.connect_ex(str(extra)), 0,
                                                "extra listener opened before readiness marker")
                        time.sleep(.02)
                    ready_at = time.monotonic()
                    (runtime / "backend.sock.ready").touch()
                    deadline = ready_at + 3
                    while True:
                        with socket.socket(socket.AF_UNIX) as probe:
                            if probe.connect_ex(str(extra)) == 0:
                                break
                        self.assertIsNone(child.poll(), "Node control exited after readiness")
                        self.assertLess(time.monotonic(), deadline, "extra listener never opened")
                        time.sleep(.02)
                    self.assertGreaterEqual(time.monotonic() - ready_at, .9,
                                            "extra listener opened too soon after readiness")
                finally:
                    child.kill()
                    child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
