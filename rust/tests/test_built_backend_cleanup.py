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
from built_backend_lifecycle import run_in_subreaper


def leave_detached_descendant(ready, hang):
    code = (
        "import os, time; from pathlib import Path; "
        f"Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    intermediate = (
        "import subprocess; subprocess.Popen("
        f"[{sys.executable!r}, '-c', {code!r}], env={{}}, start_new_session=True)"
    )
    subprocess.run([sys.executable, "-c", intermediate], check=True)
    deadline = time.monotonic() + 5
    while not ready.exists():
        if time.monotonic() > deadline:
            raise AssertionError("fixture descendant did not start")
        time.sleep(.01)
    if hang:
        time.sleep(60)
    return 42


def signal_during_reaping(signaled):
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    waitpid = os.waitpid

    def interrupted_waitpid(child, options):
        result = waitpid(child, options)
        if result[0] == pid:
            signaled.write_text(str(pid))
            os.kill(os.getpid(), signal.SIGTERM)
        return result

    os.waitpid = interrupted_waitpid
    return pid


@unittest.skipUnless(sys.platform == "linux", "Linux run-owned descendant cleanup")
class DescendantCleanupTest(unittest.TestCase):
    def test_sigterm_during_reaping_still_writes_cleanup_receipt(self):
        with tempfile.TemporaryDirectory(prefix="pp-cleanup-reaping-") as directory:
            root = Path(directory)
            signaled, receipt = root / "signaled", root / "cleanup.json"
            pid = run_in_subreaper(signal_during_reaping, (signaled,), receipt, timeout=5)
            self.assertEqual(int(signaled.read_text()), pid)
            self.assertFalse(Path(f"/proc/{pid}").exists())
            self.assertEqual(json.loads(receipt.read_text()),
                             {"killed": [], "reaped": [pid], "children_absent": True})

    def test_success_still_reaps_detached_descendants(self):
        with tempfile.TemporaryDirectory(prefix="pp-cleanup-success-") as directory:
            root = Path(directory)
            ready, receipt = root / "pid", root / "cleanup.json"
            self.assertEqual(run_in_subreaper(leave_detached_descendant, (ready, False), receipt, timeout=5), 42)
            pid = int(ready.read_text())
            self.assertFalse(Path(f"/proc/{pid}").exists())
            self.assertIn(pid, json.loads(receipt.read_text())["reaped"])

    def test_timeout_reaps_descendants_and_bounds_parent_wait(self):
        with tempfile.TemporaryDirectory(prefix="pp-cleanup-timeout-") as directory:
            root = Path(directory)
            ready, receipt = root / "pid", root / "cleanup.json"
            with self.assertRaisesRegex(TimeoutError, "isolated proof exceeded"):
                run_in_subreaper(leave_detached_descendant, (ready, True), receipt, timeout=1)
            pid = int(ready.read_text())
            self.assertFalse(Path(f"/proc/{pid}").exists())
            self.assertEqual(json.loads(receipt.read_text())["children_absent"], True)

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
Path({str(ready)!r}).write_text(json.dumps({{'pid': os.getpid(), 'port': listener.getsockname()[1], 'env': dict(os.environ), 'pgid': os.getpgrp(), 'exec_environ': Path('/proc/self/environ').read_bytes().hex()}}))
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
                self.assertEqual(info["exec_environ"], "")
                self.assertEqual(info["pgid"], info["pid"])
                self.assertTrue(any(finding["endpoint"] == f"tcp4 127.0.0.1:{info['port']}"
                                    for finding in failure.exception.found))
                self.assertTrue(any(owner["pid"] == info["pid"] and not owner["in_backend_group"]
                                    for finding in failure.exception.found
                                    for owner in finding["owners"] if isinstance(owner, dict)))
                leaked = [endpoint for endpoint in endpoints() if endpoint.port == info["port"]]
                self.assertEqual(leaked, [], "empty-env detached grandchild listener survived cleanup")
                self.assertFalse(Path(f"/proc/{info['pid']}").exists(), "grandchild was not reaped")
                cleanup = json.loads((root / "run/descendant-cleanup.json").read_text())
                self.assertIn(info["pid"], cleanup["killed"])
                self.assertIn(info["pid"], cleanup["reaped"])
                self.assertEqual(cleanup["children_absent"], True)
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
