import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from textwrap import dedent


class ShutdownTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.events = self.root / "events"
        self.events.mkdir()
        self.work = self.root / "jobs"
        self.sentinel = self.work / "prior-job"
        self.sentinel.mkdir(parents=True)
        (self.sentinel / "keep").write_text("owned by a prior run")
        self.slicer = self.root / "synthetic-slicer"
        self.slicer.write_text(
            f"#!{sys.executable}\n" + dedent("""\
                import os
                import signal
                import subprocess
                import sys
                import time
                from pathlib import Path

                events = Path(os.environ["TEST_EVENTS"])
                mode = os.environ["TEST_MODE"]
                role = "child" if sys.argv[1] == "child" else "leader"

                def record(event):
                    (events / f"{event}-{role}-{os.getpid()}").write_text(str(os.getpid()))

                def stop(signum, frame):
                    record("term")
                    if mode == "cooperative" or (mode == "leader-exit" and role == "leader"):
                        raise SystemExit(0)

                signal.signal(signal.SIGTERM, stop)
                if mode == "leader-exit" and role == "leader":
                    subprocess.Popen([sys.executable, __file__, "child"])
                record("started")
                while True:
                    time.sleep(0.01)
                """),
            encoding="utf-8",
        )
        self.slicer.chmod(0o755)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.server = None
        self.requests = []
        self.responses = []
        self.log = (self.root / "server.log").open("w+")

    def tearDown(self):
        if self.server is not None and self.server.poll() is None:
            self.server.kill()
            self.server.wait(timeout=5)
        for path in self.events.glob("started-*"):
            try:
                os.kill(int(path.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        for thread in self.requests:
            thread.join(timeout=1)
        self.log.close()
        self.temp.cleanup()

    def _wait_for(self, condition, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            if self.server is not None and self.server.poll() is not None:
                self.log.seek(0)
                self.fail(f"Sidecar exited early: {self.log.read()}")
            time.sleep(0.01)
        self.fail("Timed out waiting for the synthetic job")

    def _request(self, path="/health"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=6)
        try:
            if path == "/slice":
                body = (
                    b'--model-boundary\r\nContent-Disposition: form-data; name="model"; '
                    b'filename="plate.3mf"\r\nContent-Type: application/octet-stream\r\n\r\n'
                    b'fake model\r\n--model-boundary--\r\n'
                )
                connection.request(
                    "POST", path, body,
                    {"Content-Type": "multipart/form-data; boundary=model-boundary"},
                )
            else:
                connection.request("GET", path)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def _start_server(self, mode="cooperative", timeout=240):
        env = dict(os.environ)
        env.update(
            PORT=str(self.port),
            SLICER_BIN=str(self.slicer),
            SIDECAR_WORKDIR=str(self.work),
            WAITRESS_THREADS="8",
            SLICE_TIMEOUT_S=str(timeout),
            TEST_EVENTS=str(self.events),
            TEST_MODE=mode,
        )
        self.server = subprocess.Popen(
            [sys.executable, "-B", str(Path(__file__).with_name("sidecar.py"))],
            env=env, stdout=self.log, stderr=self.log,
        )

        def healthy():
            try:
                return self._request()[0] == 200
            except OSError:
                return False

        self._wait_for(healthy)

    def _start_jobs(self, count=1, children=0):
        def post():
            try:
                self.responses.append(self._request("/slice"))
            except (OSError, http.client.HTTPException) as error:
                self.responses.append(error)

        for _ in range(count):
            thread = threading.Thread(target=post, daemon=True)
            self.requests.append(thread)
            thread.start()
        self._wait_for(lambda: len(list(self.events.glob("started-leader-*"))) == count)
        if children:
            self._wait_for(lambda: len(list(self.events.glob("started-child-*"))) == children)

    @staticmethod
    def _is_running(pid):
        status = Path(f"/proc/{pid}/stat")
        if status.exists():
            return status.read_text().split(")", 1)[1].split()[0] != "Z"
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def _assert_clean(self):
        self.assertEqual(list(self.work.iterdir()), [self.sentinel])
        self.assertEqual((self.sentinel / "keep").read_text(), "owned by a prior run")
        for path in self.events.glob("started-*"):
            pid = int(path.read_text())
            self.assertFalse(self._is_running(pid), f"Synthetic slicer {pid} is still running")
        self.log.flush()
        self.log.seek(0)
        logs = self.log.read()
        self.assertNotIn("Traceback", logs)
        self.assertNotIn("Bad file descriptor", logs)
        self.assertNotIn("thread(s) still running", logs)

    def _stop(self, signum=signal.SIGTERM):
        started = time.monotonic()
        self.server.send_signal(signum)
        self.assertEqual(self.server.wait(timeout=4.8), 0)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 3.5)
        for thread in self.requests:
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        self._assert_clean()
        return elapsed

    def test_idle_sigterm(self):
        self._start_server()
        self.assertLess(self._stop(), 1)

    def test_idle_sigint(self):
        self._start_server()
        self.assertLess(self._stop(signal.SIGINT), 1)

    def test_cooperative_job_receives_term_and_cleans_directory(self):
        self._start_server()
        self._start_jobs()
        self.assertEqual(self._request()[0], 200)
        self.assertLess(self._stop(), 1)
        self.assertEqual(len(list(self.events.glob("term-leader-*"))), 1)

    def test_stubborn_job_is_killed_after_shared_grace(self):
        self._start_server("stubborn")
        self._start_jobs()
        self.assertGreater(self._stop(), 0.7)
        self.assertEqual(len(list(self.events.glob("term-leader-*"))), 1)

    def test_leader_exit_does_not_hide_live_grandchild(self):
        self._start_server("leader-exit")
        self._start_jobs(children=1)
        self.assertGreater(self._stop(), 0.7)
        self.assertEqual(len(list(self.events.glob("term-child-*"))), 1)

    def test_concurrent_jobs_share_one_grace_period(self):
        self._start_server("stubborn")
        self._start_jobs(count=4)
        self.assertLess(self._stop(), 2.5)
        self.assertEqual(len(list(self.events.glob("term-leader-*"))), 4)

    def test_new_job_is_rejected_while_stopping(self):
        self._start_server("stubborn")
        self._start_jobs()
        self.server.send_signal(signal.SIGTERM)
        self._wait_for(lambda: bool(list(self.events.glob("term-leader-*"))))
        status, body = self._request("/slice")
        self.assertEqual(status, 503)
        self.assertEqual(body, {"error": "sidecar is stopping"})
        self.assertEqual(len(list(self.events.glob("started-leader-*"))), 1)
        self.assertEqual(self.server.wait(timeout=4.8), 0)
        self._assert_clean()

    def test_repeated_signals_do_not_reset_deadline_or_interrupt_cleanup(self):
        self._start_server("leader-exit")
        self._start_jobs(children=1)
        started = time.monotonic()
        self.server.send_signal(signal.SIGTERM)
        self._wait_for(lambda: bool(list(self.events.glob("term-child-*"))))
        for signum in [signal.SIGINT, signal.SIGTERM] * 4:
            self.server.send_signal(signum)
            time.sleep(0.08)
        self.assertEqual(self.server.wait(timeout=4.8), 0)
        self.assertLess(time.monotonic() - started, 2.5)
        self._assert_clean()

    def test_slice_timeout_kills_descendants_and_preserves_504(self):
        self._start_server("leader-exit", timeout=1)
        self._start_jobs(children=1)
        for thread in self.requests:
            thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
        self.assertEqual(self.responses, [(504, {"error": "slicing timed out after 1s"})])
        self._assert_clean()
        self.assertEqual(self._request()[0], 200)
        self._stop()


if __name__ == "__main__":
    unittest.main()
