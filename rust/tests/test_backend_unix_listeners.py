import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backend_unix_listeners import (UnixListener, UnixListenerFound, mac_unix_listeners,
                                    proc_unix_listeners, require_private_listener, unix_listeners)

HEADER = "Num RefCount Protocol Flags Type St Inode Path\n"
TABLE = HEADER + """\
0000000000000000: 00000002 00000000 00010000 0001 01 101 /tmp/private dir/backend.sock
0000000000000000: 00000003 00000000 00000000 0001 03 102 /tmp/private dir/backend.sock
0000000000000000: 00000002 00000000 00000000 0001 01 103 /tmp/bound.sock
0000000000000000: 00000002 00000000 00010000 0005 01 104 @abstract name
0000000000000000: 00000002 00000000 00010000 0001 01 105
0000000000000000: 00000002 00000000 00010000 0001 01 106 /tmp/other-process.sock
"""


class Parsers(unittest.TestCase):
    def test_linux_listener_identity_and_attribution(self):
        self.assertEqual(proc_unix_listeners(TABLE, {101, 102, 103, 104, 105}, 42), [
            UnixListener("101", "/tmp/private dir/backend.sock", 42),
            UnixListener("104", "@abstract name", 42), UnixListener("105", None, 42)])
        self.assertEqual(proc_unix_listeners(HEADER, {101}, 42), [])

    def test_linux_malformed_observations(self):
        for text in ("", "garbage", HEADER + "\n", HEADER + "0: 2 0 10000 1 01",
                     TABLE.replace("00010000", "badflags", 1), TABLE.replace(" 101 ", " invalid ", 1),
                     TABLE.replace("0001 01 101", "0001 03 101", 1),
                     TABLE.replace("0001 01 101", "0002 01 101", 1)):
            with self.subTest(text=text), self.assertRaises(AssertionError):
                proc_unix_listeners(text, {101}, 42)

    def test_macos_framing_paths_and_duplicate_descriptors(self):
        self.assertEqual(mac_unix_listeners(
            "unix-listeners-v1 42\nab\t2f746d702f612062\nab\t2f746d702f612062\ncd\t\nend\n", 42),
            [UnixListener("ab", "/tmp/a b", 42), UnixListener("cd", None, 42)])
        self.assertEqual(mac_unix_listeners("unix-listeners-v1 42\nend\n", 42), [])

    def test_macos_malformed_observations(self):
        for text in ("", "unix-listeners-v1 41\nend\n", "unix-listeners-v1 42\n",
                     "unix-listeners-v1 42\n0\t00\nend\n", "unix-listeners-v1 42\nab\txx\nend\n",
                     "unix-listeners-v1 42\nab\t2\nend\n", "unix-listeners-v1 42\ngarbage\nend\n"):
            with self.subTest(text=text), self.assertRaises(AssertionError):
                mac_unix_listeners(text, 42)

    def test_macos_observer_errors_fail_closed(self):
        for result in (subprocess.CompletedProcess([], 1, "", "denied"),
                       subprocess.CompletedProcess([], 0, "unix-listeners-v1 42\nend\n", "warning"),
                       subprocess.CompletedProcess([], 0, "", "")):
            with patch("backend_unix_listeners.sys.platform", "darwin"), \
                    patch("backend_unix_listeners.mac_helper", return_value=Path("observer")), \
                    patch("backend_unix_listeners.subprocess.run", return_value=result), \
                    self.assertRaisesRegex(AssertionError, "observation unavailable"):
                unix_listeners(42)

    def test_exact_set_before_and_after_readiness(self):
        expected = "/tmp/backend.sock"
        private = UnixListener("101", expected, 42)
        self.assertIsNone(require_private_listener(expected, [], False))
        self.assertIsNone(require_private_listener(expected, [private], True))
        for found, ready in (([], True), ([UnixListener("102", expected, 42), private], True),
                             ([UnixListener("103", "/tmp/extra.sock", 42)], False),
                             ([UnixListener("104", None, 42)], False),
                             ([UnixListener("105", "@abstract", 42)], True)):
            with self.subTest(found=found), self.assertRaises(UnixListenerFound):
                require_private_listener(expected, found, ready)


@unittest.skipUnless(sys.platform in ("linux", "darwin"), "requires a supported Unix kernel")
class LiveSockets(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pp-unix-test-")
        self.addCleanup(self.directory.cleanup)
        self.expected = str(Path(self.directory.name).resolve() / "backend.sock")
        self.before = set(unix_listeners(os.getpid()))

    def listener(self, path):
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        listener.bind(path)
        listener.listen()
        return listener

    def observed(self):
        return sorted(set(unix_listeners(os.getpid())) - self.before, key=lambda item: item.identity)

    def test_connected_and_bound_sockets_do_not_count(self):
        listener = self.listener(self.expected)
        client = socket.socket(socket.AF_UNIX)
        self.addCleanup(client.close)
        client.connect(self.expected)
        accepted, _ = listener.accept()
        self.addCleanup(accepted.close)
        bound = socket.socket(socket.AF_UNIX)
        self.addCleanup(bound.close)
        bound.bind(str(Path(self.directory.name) / "bound socket"))
        found = self.observed()
        self.assertEqual([(item.path, item.pid) for item in found], [(self.expected, os.getpid())])
        require_private_listener(self.expected, found, True)
        listener.close()
        with self.assertRaises(UnixListenerFound):
            require_private_listener(self.expected, self.observed(), True)

    def test_watch_rejects_extra_backend_listener(self):
        from built_backend_listeners import Watch
        watch = Watch(self.expected)
        watch.backend = os.getpid()
        watch.poll()
        self.listener(self.expected)
        watch.ready = True
        watch.poll()
        extra = str(Path(self.directory.name) / "extra socket")
        self.listener(extra)
        with self.assertRaises(UnixListenerFound) as caught:
            watch.poll()
        self.assertEqual(sorted(item.path for item in caught.exception.found), sorted([self.expected, extra]))

    def test_watch_rejects_missing_listener_after_ready(self):
        from built_backend_listeners import Watch
        watch = Watch(self.expected)
        watch.backend = os.getpid()
        listener = self.listener(self.expected)
        watch.ready = True
        watch.poll()
        listener.close()
        with self.assertRaises(UnixListenerFound):
            watch.poll()

    def test_observation_errors_fail_closed(self):
        with patch("backend_unix_listeners.Path.read_text", side_effect=PermissionError("denied")):
            if sys.platform == "linux":
                with self.assertRaisesRegex(AssertionError, "observation unavailable"):
                    unix_listeners(os.getpid())
        with self.assertRaisesRegex(AssertionError, "observation unavailable"):
            unix_listeners(2147483647)

    @unittest.skipUnless(sys.platform == "linux", "Linux abstract namespace")
    def test_abstract_listener(self):
        self.listener("\0pp-unix-test-" + str(os.getpid()))
        found = self.observed()
        self.assertEqual([(item.path, item.pid) for item in found],
                         [("@pp-unix-test-" + str(os.getpid()), os.getpid())])
        with self.assertRaises(UnixListenerFound):
            require_private_listener(self.expected, found, False)


def self_test():
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if not result.wasSuccessful():
        raise AssertionError("Unix listener self-test failed")


if __name__ == "__main__":
    unittest.main()
