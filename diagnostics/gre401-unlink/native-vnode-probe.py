#!/usr/bin/env python3
"""Throwaway native observations. This instrument makes no safety verdict."""
import argparse
from contextlib import closing
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import stat
import struct
import subprocess
import sys
import time


class AttrList(ctypes.Structure):
    _fields_ = [("bitmapcount", ctypes.c_uint16), ("reserved", ctypes.c_uint16),
                ("commonattr", ctypes.c_uint32), ("volattr", ctypes.c_uint32),
                ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                ("forkattr", ctypes.c_uint32)]


def stat_data(st):
    return {key: getattr(st, "st_" + key) for key in
            ("dev", "ino", "nlink", "mode", "uid", "gid", "size", "ctime_ns", "mtime_ns")}


def attempt(fn):
    try:
        return {"status": "observed", "value": fn()}
    except OSError as exc:
        return {"status": "error", "errno": exc.errno, "error": str(exc)}


class OwnedTree:
    def __init__(self, root):
        self.root = root

    def path(self, name):
        candidate = self.root / name
        if not candidate.is_relative_to(self.root) or ".." in candidate.parts:
            raise ValueError("path escapes the owned root")
        if not candidate.resolve().is_relative_to(self.root):
            raise ValueError("resolved path escapes the owned root")
        return candidate

    def mkdir(self, name):
        self.path(name).mkdir(mode=0o700)

    def rename(self, source, target):
        os.rename(self.path(source), self.path(target))

    def rmdir(self, name):
        os.rmdir(self.path(name))

    def chmod(self, name, mode):
        os.chmod(self.path(name), mode)

    def write(self, name, content):
        with self.path(name).open("x") as stream:
            stream.write(content)

    def unlink(self, name):
        self.path(name).unlink()

    def identity(self, name):
        return attempt(lambda: stat_data(self.path(name).lstat()))


class Native:
    def __init__(self, sdk):
        self.constants = sdk["constants"]
        self.options = (0, self.constants["FSOPT_PACK_INVAL_ATTRS"])
        abi = sdk["abi"]
        if (abi["attrlist_size"] != ctypes.sizeof(AttrList)
                or abi["attrlist_offsets"] != [getattr(AttrList, name).offset for name, _ in AttrList._fields_]
                or abi["attribute_set_size"] != 20 or abi["uint32_size"] != 4
                or abi["uint_size"] != ctypes.sizeof(ctypes.c_uint)
                or abi["size_t_size"] != ctypes.sizeof(ctypes.c_size_t)):
            raise ValueError("ctypes layout disagrees with the compiled macOS SDK")
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.getattr = getattr(self.libc, "fgetattrlist", None)
        if self.getattr is not None:
            self.getattr.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                     ctypes.c_size_t, ctypes.c_uint]
            self.getattr.restype = ctypes.c_int
        self.swap = getattr(self.libc, "renamex_np", None)
        if self.swap is not None:
            self.swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            self.swap.restype = ctypes.c_int
        self.notes = {n: self.constants["NOTE_" + n] for n in
                      ("DELETE", "RENAME", "REVOKE", "LINK", "WRITE", "ATTRIB", "EXTEND")}
        mapping = {"EVFILT_VNODE": "KQ_FILTER_VNODE"}
        mapping.update({name: "KQ_" + name for name in self.constants
                        if name.startswith(("EV_", "NOTE_"))})
        self.select_bindings = {name: {"sdk": self.constants[name],
                                       "python": getattr(select, binding, None)}
                                for name, binding in mapping.items()}
        for binding in self.select_bindings.values():
            if binding["python"] is not None and binding["python"] != binding["sdk"]:
                raise ValueError("Python select constant disagrees with the macOS SDK")

    def attrs(self, fd, options):
        if self.getattr is None:
            return {"status": "unavailable", "api": "fgetattrlist"}
        common = self.constants["ATTR_CMN_RETURNED_ATTRS"]
        directory = self.constants["ATTR_DIR_LINKCOUNT"]
        request = AttrList(self.constants["ATTR_BIT_MAP_COUNT"], 0, common, 0, directory, 0, 0)
        buffer = ctypes.create_string_buffer(b"\xa5" * 64, 64)
        ctypes.set_errno(0)
        rc = self.getattr(fd, ctypes.byref(request), buffer, len(buffer), options)
        error = ctypes.get_errno()
        raw = buffer.raw
        row = {"rc": rc, "errno": error, "options": options, "raw_hex": raw.hex(), "fd": fd,
               "request_hex": bytes(request).hex(), "buffer_size": len(raw),
               "status": "error" if rc else "unparsed"}
        if rc:
            return row
        length = struct.unpack_from("=I", raw)[0]
        row["length"] = length
        if length < 24 or length > len(raw):
            row["status"] = "invalid_length"
            return row
        masks = dict(zip(("common", "volume", "directory", "file", "fork"),
                         struct.unpack_from("=5I", raw, 4)))
        row["returned_masks"] = masks
        if masks != {"common": common, "volume": 0, "directory": directory, "file": 0, "fork": 0}:
            row["status"] = "missing_or_unexpected_attributes"
            return row
        if length != 28:
            row["status"] = "unexpected_packed_length"
            return row
        row.update(status="returned", dir_linkcount=struct.unpack_from("=I", raw, 24)[0],
                   semantics="may be generic default one; returned mask does not prove filesystem implementation")
        return row

    def event_data(self, events):
        return [{"ident": e.ident, "filter": e.filter, "flags": e.flags,
                 "fflags": e.fflags, "data": e.data, "udata": e.udata,
                 "notes": [n for n, bit in self.notes.items() if e.fflags & bit]}
                for e in events]

    def register(self, kq, fd):
        constants = self.constants
        registration = select.kevent(fd, filter=constants["EVFILT_VNODE"],
            flags=constants["EV_ADD"] | constants["EV_CLEAR"] | constants["EV_RECEIPT"],
            fflags=sum(self.notes.values()))
        receipt = attempt(lambda: self.event_data(kq.control([registration], 1, 0)))
        events = receipt.get("value", [])
        valid = (len(events) == 1 and events[0]["ident"] == fd
                 and events[0]["filter"] == constants["EVFILT_VNODE"]
                 and events[0]["flags"] & constants["EV_ERROR"] and events[0]["data"] == 0)
        return {"status": "registered" if valid else "unavailable_or_failed", "receipt": receipt,
                "request": self.event_data([registration]), "kqueue_fd": kq.fileno()}

    def exchange(self, tree, source, target):
        if self.swap is None:
            return {"status": "unavailable", "api": "renamex_np"}
        ctypes.set_errno(0)
        flags = self.constants["RENAME_SWAP"]
        rc = self.swap(os.fsencode(tree.path(source)), os.fsencode(tree.path(target)), flags)
        return {"status": "completed" if rc == 0 else "error_or_unsupported",
                "rc": rc, "errno": ctypes.get_errno(), "flags": flags}


def snapshot(native, tree, fd, names):
    before = attempt(lambda: stat_data(os.fstat(fd)))
    attrs = [native.attrs(fd, options) for options in native.options]
    after = attempt(lambda: stat_data(os.fstat(fd)))
    return {"monotonic_ns": time.monotonic_ns(), "fd": fd, "held_before_attrs": before,
            "attrs": attrs, "held_after_attrs": after,
            "named": {name: tree.identity(name) for name in names}}


CASES = {
    "unchanged": [],
    "ordinary_rename": [("rename", "lease", "renamed")],
    "publication": [("rename", "lease", ".desktop-lease")],
    "detach": [("rename", "lease", ".desktop-lease"), ("rename", ".desktop-lease", ".detached")],
    "parent_rename": [("rename_parent",)],
    "case_rename": [("rename", "lease", "LEASE")],
    "child_changes_case_rename": [("mkdir", "lease/child"), ("rmdir", "lease/child"), ("rename", "lease", "LEASE")],
    "swap_source": [("swap", "lease", "other")],
    "swap_target": [("swap", "other", "lease")],
    "delete": [("rmdir", "lease")],
    "rename_delete": [("rename", "lease", "renamed"), ("rmdir", "renamed")],
    "shared_delete_successor": [("rmdir", "lease"), ("successor", "lease")],
    "renamed_delete_successor": [("rename", "lease", "renamed"), ("rmdir", "renamed"), ("successor", "lease")],
    "detached_delete_successor": [("rename", "lease", ".desktop-lease"), ("rename", ".desktop-lease", ".detached"), ("rmdir", ".detached"), ("successor", ".desktop-lease"), ("successor", ".detached")],
    "linked_rename_successor": [("rename", "lease", "renamed"), ("successor", "lease")],
    "delete_successor_then_delete_successor": [("rmdir", "lease"), ("successor", "lease"), ("unlink", "lease/successor.txt"), ("rmdir", "lease")],
    "failed_rmdir_nonempty": [("mkdir", "lease/child"), ("rmdir", "lease")],
    "permissions": [("chmod", "parent", 0)],
    "late_registration_after_delete": [("rmdir", "lease")],
}


def run_case(native, tree, kind, actions):
    tree.mkdir(kind)
    tree.mkdir(kind + "/parent")
    prefix = kind + "/parent/"
    tree.mkdir(prefix + "lease")
    tree.mkdir(prefix + "other")
    names = [prefix + name for name in ("lease", "renamed", "other", "LEASE", ".desktop-lease", ".detached")]
    names.append(kind + "/moved-parent/lease")
    fd = os.open(tree.path(prefix + "lease"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    row = {"case": kind, "actions": [], "successors": [], "fd": fd}
    try:
        with closing(select.kqueue()) as kq:
            row["initial"] = snapshot(native, tree, fd, names)
            late = kind == "late_registration_after_delete"
            if not late:
                row["registration"] = native.register(kq, fd)
                if row["registration"]["status"] != "registered":
                    row["status"] = "unexecuted_registration_failed"
                    return row
                row["baseline_events"] = attempt(lambda: native.event_data(kq.control(None, 8, 0)))
            for action in actions:
                op, *args = action
                def execute():
                    if op == "rename_parent":
                        return tree.rename(kind + "/parent", kind + "/moved-parent")
                    if op == "chmod":
                        return tree.chmod(kind + "/parent", args[1])
                    if op == "swap":
                        return native.exchange(tree, prefix + args[0], prefix + args[1])
                    if op == "successor":
                        name = prefix + args[0]
                        tree.mkdir(name)
                        tree.write(name + "/successor.txt", "successor " + kind + "\n")
                        row["successors"].append({"name": name, "created_identity": tree.identity(name),
                            "created_content": tree.path(name + "/successor.txt").read_text()})
                        return None
                    return getattr(tree, op)(*[prefix + arg for arg in args])
                outcome = attempt(execute)
                row["actions"].append({"operation": action, "outcome": outcome,
                                       "after_action": snapshot(native, tree, fd, names)})
                if (outcome["status"] == "error"
                        or (isinstance(outcome.get("value"), dict)
                            and outcome["value"].get("status") != "completed")):
                    break
            if late:
                row["registration"] = native.register(kq, fd)
            row["after"] = snapshot(native, tree, fd, names)
            initial = row["initial"]["held_before_attrs"].get("value")
            final = row["after"]["held_after_attrs"].get("value")
            row["held_identity_stable"] = (None if initial is None or final is None else
                (initial["dev"], initial["ino"]) == (final["dev"], final["ino"]))
            row["control_execution"] = "completed"
            for action in row["actions"]:
                outcome = action["outcome"]
                value = outcome.get("value")
                if outcome["status"] == "error" or (isinstance(value, dict) and value.get("status") != "completed"):
                    row["control_execution"] = "error_or_unavailable"
            row["polls"] = []
            for _ in range(3):
                row["polls"].append({"monotonic_ns": time.monotonic_ns(),
                    "result": attempt(lambda: native.event_data(kq.control(None, 8, 0)))})
                time.sleep(0.02)
            for successor in row["successors"]:
                name = successor["name"]
                successor["final_identity"] = tree.identity(name)
                successor["final_content"] = attempt(lambda: tree.path(name + "/successor.txt").read_text())
            row["status"] = "observations_only"
    finally:
        if kind == "permissions":
            row["permission_restore"] = attempt(lambda: tree.chmod(kind + "/parent", 0o700))
        os.close(fd)
    return row


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {"argv": args, "rc": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"argv": args, "status": "unavailable", "error": str(exc)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--sdk-helper")
    args = parser.parse_args()
    if sys.platform != "darwin" or not hasattr(select, "kqueue"):
        print(json.dumps({"status": "UNEXECUTED_NATIVE_REQUIRED", "native_executed": False,
                          "host": platform.platform()}))
        return 77
    if not args.sdk_helper:
        parser.error("--sdk-helper must name the compiled native-sdk instrument")
    supplied = Path(args.root)
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    root = supplied.resolve(strict=True)
    info = root.stat()
    if (supplied.is_symlink() or root == runner_temp or not root.is_relative_to(runner_temp)
            or not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
            or info.st_uid != os.getuid() or any(root.iterdir())):
        raise ValueError("root must be fresh, empty, owned, mode 0700 and below RUNNER_TEMP")
    if ctypes.sizeof(AttrList) != 24 or [getattr(AttrList, name).offset for name, _ in AttrList._fields_] != [0, 2, 4, 8, 12, 16, 20]:
        raise ValueError("unexpected attrlist ABI")
    sdk_command = command([args.sdk_helper, str(root)])
    print(json.dumps({"sdk_command": sdk_command}), flush=True)
    if sdk_command.get("rc") != 0:
        raise RuntimeError("native SDK metadata failed: " + json.dumps(sdk_command))
    sdk = json.loads(sdk_command["stdout"])
    tree = OwnedTree(root)
    native = Native(sdk)
    commands = [command(argv) for argv in (["sw_vers"], ["uname", "-a"],
                ["df", "-P", str(root)])]
    if sdk["statfs"]["rc"] == 0:
        commands.append(command(["/usr/sbin/diskutil", "info", "-plist", sdk["statfs"]["mounted_device"]]))
    result = {"status": "NATIVE_OBSERVATIONS_ONLY", "native_executed": True,
              "safety_verdict": "NOT_EVALUATED", "root": str(root), "uid": os.getuid(),
              "source_commit": os.environ.get("GITHUB_SHA"), "platform": platform.platform(),
              "uname": list(platform.uname()), "python": sys.version,
              "commands": commands, "sdk_command": sdk_command, "sdk": sdk,
              "select_bindings": native.select_bindings,
              "abi": {"attrlist_size": ctypes.sizeof(AttrList), "options": native.options},
              "hashes": {}, "cases": [],
              "unexecuted_controls": ["forced revoke/unmount prohibited", "product release/retry/Drop and successor race protocols outside scope", "other filesystems and OS releases"]}
    source_root = Path(__file__).resolve().parent
    for path in sorted(source_root.iterdir()):
        if path.is_file():
            result["hashes"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    workflow = source_root.parents[1] / ".github/workflows/desktop-native-macos.yml"
    result["hashes"]["workflow"] = hashlib.sha256(workflow.read_bytes()).hexdigest()
    tree.mkdir("CaseSensitivityControl")
    created = tree.identity("CaseSensitivityControl")
    alternate = tree.identity("casesensitivitycontrol")
    sensitivity = "unknown"
    if alternate.get("errno") == 2:
        sensitivity = "case_sensitive"
    elif alternate.get("status") == "observed":
        a, b = created["value"], alternate["value"]
        if (a["dev"], a["ino"]) == (b["dev"], b["ino"]):
            sensitivity = "case_insensitive"
    result["case_sensitivity"] = {"created": created, "alternate": alternate,
                                  "observation": sensitivity}
    result["invalid_descriptor_attribute_control"] = [native.attrs(-1, flag) for flag in native.options]
    tree.write("metadata.json", json.dumps(result, indent=2) + "\n")
    for kind, actions in CASES.items():
        row = run_case(native, tree, kind, actions)
        result["cases"].append(row)
        tree.write(kind + ".json", json.dumps(row, indent=2) + "\n")
    tree.write("observations.json", json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "observations": str(root / "observations.json"),
                      "case_count": len(result["cases"]), "safety_verdict": "NOT_EVALUATED"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
