import atexit
from collections import namedtuple
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from built_backend_lifecycle import require

UnixListener = namedtuple("UnixListener", "identity path pid")
PROC_HEADER = "Num RefCount Protocol Flags Type St Inode Path".split()
_MAC_HELPER = None


def proc_unix_listeners(text, inodes, pid):
    lines = text.splitlines()
    require(lines and lines[0].split() == PROC_HEADER, "unparseable /proc/net/unix header")
    found = set()
    for row in lines[1:]:
        fields = row.split(maxsplit=7)
        require(len(fields) >= 7 and re.fullmatch(r"[0-9a-fA-F]+:", fields[0]) is not None
                and all(re.fullmatch(r"[0-9a-fA-F]+", value) for value in fields[1:6])
                and fields[6].isdigit(), f"unparseable /proc/net/unix row: {row!r}")
        flags, kind, state = (int(fields[index], 16) for index in (3, 4, 5))
        inode = int(fields[6])
        # SO_ACCEPTCON distinguishes listeners from bound and accepted sockets sharing the same path.
        if flags & 0x10000:
            require(kind in (1, 5) and state == 1 and inode > 0, f"invalid Unix listener: {row!r}")
            if inode in inodes:
                found.add(UnixListener(str(inode), fields[7] if len(fields) == 8 else None, pid))
    return sorted(found, key=lambda item: item.identity)


def mac_unix_listeners(text, pid):
    lines = text.splitlines()
    require(lines and lines[0] == f"unix-listeners-v1 {pid}" and lines[-1] == "end",
            "incomplete macOS Unix listener observation")
    found = set()
    for row in lines[1:-1]:
        fields = row.split("\t")
        require(len(fields) == 2 and re.fullmatch(r"[0-9a-f]+", fields[0]) is not None
                and int(fields[0], 16) > 0 and re.fullmatch(r"(?:[0-9a-f]{2})*", fields[1]) is not None,
                f"unparseable macOS Unix listener: {row!r}")
        found.add(UnixListener(fields[0], os.fsdecode(bytes.fromhex(fields[1])) or None, pid))
    return sorted(found, key=lambda item: item.identity)


def mac_helper():
    global _MAC_HELPER
    if _MAC_HELPER is None:
        directory = tempfile.TemporaryDirectory(prefix="pp-unix-observer-")
        atexit.register(directory.cleanup)
        helper = Path(directory.name) / "unix-listeners"
        source = Path(__file__).with_name("backend_unix_listeners_macos.c")
        result = subprocess.run(["/usr/bin/cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                                 str(source), "-o", str(helper)], capture_output=True, text=True)
        require(result.returncode == 0, f"cannot build macOS Unix observer: {result.stderr}")
        _MAC_HELPER = helper
    return _MAC_HELPER


def unix_listeners(pid):
    try:
        if sys.platform == "linux":
            inodes = set()
            for fd in Path(f"/proc/{pid}/fd").iterdir():
                try:
                    target = os.readlink(fd)
                except FileNotFoundError:
                    continue
                match = re.fullmatch(r"socket:\[(\d+)\]", target)
                if match:
                    inodes.add(int(match[1]))
            return proc_unix_listeners(Path(f"/proc/{pid}/net/unix").read_text(), inodes, pid)
        require(sys.platform == "darwin", f"unsupported Unix listener platform: {sys.platform}")
        result = subprocess.run([str(mac_helper()), str(pid)], capture_output=True, text=True)
        require(result.returncode == 0 and not result.stderr,
                f"macOS Unix observer failed: {result.returncode}, {result.stderr!r}")
        return mac_unix_listeners(result.stdout, pid)
    except (OSError, ValueError, AssertionError) as error:
        raise AssertionError(f"Unix listener observation unavailable for backend {pid}: {error}") from error


class UnixListenerFound(AssertionError):
    def __init__(self, expected, found):
        self.expected, self.found = str(expected), found
        super().__init__(f"backend Unix listener set mismatch: expected {[self.expected]}, observed {found}")


def require_private_listener(expected, found, ready):
    if any(listener.path != str(expected) for listener in found) or len(found) > 1 or (ready and len(found) != 1):
        raise UnixListenerFound(expected, found)
