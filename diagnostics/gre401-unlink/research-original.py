#!/usr/bin/env python3
"""Native macOS observations only. Keep all created objects beneath --root."""
import argparse
import ctypes
import errno
import json
import os
import pathlib
import platform
import select
import subprocess
import sys
import tempfile


class AttrList(ctypes.Structure):
    _fields_ = [("bitmapcount", ctypes.c_uint16), ("reserved", ctypes.c_uint16),
                ("commonattr", ctypes.c_uint32), ("volattr", ctypes.c_uint32),
                ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                ("forkattr", ctypes.c_uint32)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    if sys.platform != "darwin" or not hasattr(select, "kqueue"):
        print(json.dumps({"status": "UNEXECUTED_NATIVE_REQUIRED", "host": platform.platform()}))
        return 77
    root = pathlib.Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit("--root must already be a private scratch directory")
    session = pathlib.Path(tempfile.mkdtemp(prefix="native-vnode-", dir=root))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fgetattrlist.argtypes = [ctypes.c_int, ctypes.POINTER(AttrList), ctypes.c_void_p,
                                 ctypes.c_size_t, ctypes.c_ulong]
    libc.fgetattrlist.restype = ctypes.c_int
    libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    libc.renamex_np.restype = ctypes.c_int
    notes = {n: getattr(select, "KQ_NOTE_" + n) for n in
             ["DELETE", "RENAME", "REVOKE", "LINK", "WRITE", "ATTRIB"]}
    mask = sum(notes.values())
    rows = []

    def attrs(fd):
        request = AttrList(5, 0, 0x80000000, 0, 1, 0, 0)
        buffer = (ctypes.c_uint32 * 7)()
        rc = libc.fgetattrlist(fd, ctypes.byref(request), buffer, ctypes.sizeof(buffer), 0)
        if rc:
            return {"errno": ctypes.get_errno()}
        return {"length": buffer[0], "returned_common": buffer[1],
                "returned_dir": buffer[3], "dir_linkcount": buffer[6],
                "raw_words": list(buffer)}

    def identity(path):
        try:
            st = os.lstat(path)
            return {"dev": st.st_dev, "ino": st.st_ino, "nlink": st.st_nlink}
        except OSError as e:
            return {"errno": e.errno}

    def event_data(events):
        return [{"ident": e.ident, "filter": e.filter, "flags": e.flags,
                 "fflags": e.fflags, "data": e.data,
                 "notes": [n for n, bit in notes.items() if e.fflags & bit]} for e in events]

    for kind in ["unchanged", "rename", "rename_successor", "delete", "delete_successor",
                 "rename_delete_successor", "delete_successor_then_delete_successor",
                 "parent_rename", "inaccessible_parent", "failed_rmdir_nonempty",
                 "case_rename", "child_change_case_rename", "swap_source", "swap_target"]:
        base = session / kind
        base.mkdir()
        parent = base / "parent"
        parent.mkdir()
        original = parent / "lease"
        original.mkdir()
        renamed = parent / "renamed"
        other = parent / "other"
        other.mkdir()
        fd = os.open(original, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        kq = select.kqueue()
        try:
            registration = select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR | select.KQ_EV_RECEIPT, fflags=mask)
            receipts = kq.control([registration], 1, 0)
            if len(receipts) != 1 or receipts[0].data != 0 or not receipts[0].flags & select.KQ_EV_ERROR:
                raise RuntimeError("registration did not return a successful EV_RECEIPT")
            initial = {"held": identity(original), "attrs": attrs(fd)}
            action_errno = None
            try:
                if kind in ["rename", "rename_successor", "rename_delete_successor"]:
                    os.rename(original, renamed)
                    if kind == "rename_delete_successor":
                        os.rmdir(renamed)
                    if kind != "rename":
                        original.mkdir()
                elif kind in ["delete", "delete_successor", "delete_successor_then_delete_successor"]:
                    os.rmdir(original)
                    if kind != "delete":
                        original.mkdir()
                    if kind == "delete_successor_then_delete_successor":
                        os.rmdir(original)
                elif kind == "parent_rename":
                    os.rename(parent, base / "moved-parent")
                elif kind == "inaccessible_parent":
                    parent.chmod(0)
                elif kind == "failed_rmdir_nonempty":
                    (original / "keep").write_text("keep")
                    os.rmdir(original)
                elif kind in ["case_rename", "child_change_case_rename"]:
                    if kind == "child_change_case_rename":
                        (original / "child").mkdir()
                        (original / "child").rmdir()
                    os.rename(original, parent / "LEASE")
                elif kind.startswith("swap_"):
                    source, target = (original, other) if kind == "swap_source" else (other, original)
                    if libc.renamex_np(os.fsencode(source), os.fsencode(target), 2):
                        raise OSError(ctypes.get_errno(), "renamex_np RENAME_SWAP")
            except OSError as e:
                action_errno = e.errno
            held = os.fstat(fd)
            events = kq.control(None, 1, 0)
            rows.append({"case": kind, "initial": initial, "action_errno": action_errno,
                         "held_after": {"dev": held.st_dev, "ino": held.st_ino, "nlink": held.st_nlink},
                         "attrs_after": attrs(fd), "events": event_data(events),
                         "second_poll": event_data(kq.control(None, 1, 0)),
                         "named_after": {str(p.relative_to(base)): identity(p) for p in
                             [original, renamed, other, parent / "LEASE", base / "moved-parent/lease"]}})
        finally:
            if kind == "inaccessible_parent":
                parent.chmod(0o700)
            kq.close()
            os.close(fd)
    result = {"status": "NATIVE_OBSERVATIONS_ONLY", "platform": platform.platform(),
              "sw_vers": subprocess.run(["sw_vers"], capture_output=True, text=True).stdout,
              "filesystem_info": subprocess.run(["df", str(session)], capture_output=True, text=True).stdout,
              "scratch": str(session), "cases": rows}
    destination = session / "observations.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(str(destination))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
