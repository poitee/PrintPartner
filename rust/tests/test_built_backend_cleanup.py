"""Focused Linux listener cleanup regressions. No built backend is required."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from built_backend_listeners import ListenerFound, Watch, endpoints, run_backend


@unittest.skipUnless(sys.platform == "linux", "Linux run-owned descendant cleanup")
class DescendantCleanupTest(unittest.TestCase):
    def test_empty_env_detached_grandchild_is_removed_before_next_baseline(self):
        with tempfile.TemporaryDirectory(prefix="pp-cleanup-test-") as directory:
            root = Path(directory)
            ready = root / "grandchild.json"
            grandchild = f"""
import json, os, socket, time
from pathlib import Path
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
Path({str(ready)!r}).write_text(json.dumps({{'pid': os.getpid(), 'port': listener.getsockname()[1], 'env': dict(os.environ)}}))
while True:
    time.sleep(.05)
"""
            intermediate = (
                "import subprocess; subprocess.Popen("
                f"[{sys.executable!r}, '-c', {grandchild!r}], "
                "env={}, start_new_session=True, stdin=subprocess.DEVNULL, "
                "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"
            )
            backend = root / "backend"
            backend.write_text(
                f"#!{sys.executable}\nimport subprocess, time\n"
                f"subprocess.run([{sys.executable!r}, '-c', {intermediate!r}], check=True)\n"
                "while True: time.sleep(.05)\n"
            )
            backend.chmod(0o700)
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            try:
                with self.assertRaises(ListenerFound) as failure:
                    run_backend(backend, root / "run")
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                info = json.loads(ready.read_text())
                self.assertNotIn("PP_LISTENER_PROOF_RUN", info["env"])
                self.assertEqual(os.getpgid(info["pid"]) if Path(f"/proc/{info['pid']}").exists()
                                 else info["pid"], info["pid"])
                self.assertTrue(any(finding["endpoint"] == f"tcp4 127.0.0.1:{info['port']}"
                                    for finding in failure.exception.found))
                self.assertTrue(any(owner["pid"] == info["pid"] and not owner["in_backend_group"]
                                    for finding in failure.exception.found
                                    for owner in finding["owners"] if isinstance(owner, dict)))
                leaked = [endpoint for endpoint in endpoints() if endpoint.port == info["port"]]
                self.assertEqual(leaked, [], "empty-env detached grandchild listener survived cleanup")
                self.assertFalse(Path(f"/proc/{info['pid']}").exists(), "grandchild was not reaped")
                next_run = Watch()
                self.assertEqual([endpoint for endpoint in next_run.baseline if endpoint.port == info["port"]], [])
                self.assertIsNone(unrelated.poll(), "cleanup killed an unrelated caller child")
            finally:
                if ready.exists():
                    pid = json.loads(ready.read_text())["pid"]
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                unrelated.kill()
                unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
