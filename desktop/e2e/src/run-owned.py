#!/usr/bin/env python3
"""Run Linux automation as a subreaper so orphaned WebKit children are reaped."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


def identity(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        return text[text.rindex(")") + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def descendants(root):
    parents = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            parent = int(next(line for line in status.splitlines() if line.startswith("PPid:")).split()[1])
            parents.setdefault(parent, []).append(int(entry.name))
        except (OSError, ValueError, StopIteration):
            continue
    found = set()
    pending = list(parents.get(root, []))
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.add(pid)
        pending.extend(parents.get(pid, []))
    return found


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "cannot become the automation subreaper")
    output = Path(os.environ["GRE492_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node is required")
    interrupted = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda received, _frame: interrupted.append(received))
    child = subprocess.Popen([node, "--import", "tsx", "src/run.ts"], start_new_session=True)
    acquired = {child.pid: identity(child.pid)}
    history = []
    refusals = []
    reaped = []
    signals = []
    result = None

    def observe():
        # Only descendants of this subreaper can enter the owned set.
        for pid in descendants(os.getpid()):
            start = identity(pid)
            if start and acquired.get(pid) != start:
                history.append({"pid": pid, "previous_identity": acquired.get(pid),
                                "start_identity": start})
                acquired[pid] = start

    def live():
        found = []
        for pid, start in acquired.items():
            current = identity(pid)
            if start and current == start:
                found.append(pid)
            elif current and current != start:
                refusal = {"pid": pid, "acquired_identity": start,
                           "current_identity": current, "signal": "census-refused"}
                if refusal not in refusals:
                    refusals.append(refusal)
        return found

    def reap():
        nonlocal result
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            reaped.append({"pid": pid, "status": status})
            if pid == child.pid:
                result = os.waitstatus_to_exitcode(status)
                child.returncode = result

    def send(sig):
        for pid in live():
            # Recheck the start identity immediately before each positive-PID signal.
            current = identity(pid)
            if current != acquired[pid]:
                refusals.append({"pid": pid, "acquired_identity": acquired[pid],
                                 "current_identity": current, "signal": sig.name})
                continue
            try:
                os.kill(pid, sig)
                signals.append({"pid": pid, "start_identity": acquired[pid], "signal": sig.name})
            except ProcessLookupError:
                pass

    try:
        while result is None and not interrupted:
            observe()
            reap()
            time.sleep(0.02)
    finally:
        observe()
        for sig, duration in ((signal.SIGTERM, 8), (signal.SIGKILL, 3)):
            if not live():
                break
            send(sig)
            deadline = time.monotonic() + duration
            while live() and time.monotonic() < deadline:
                observe()
                reap()
                time.sleep(0.02)
        reap()
        observe()
        survivors = live()
        receipt = {"runner_pid": child.pid, "runner_exit": result,
                   "owned_start_identities": acquired, "reaped": reaped,
                   "signals": signals, "identity_history": history,
                   "signal_refusals": refusals, "survivors": survivors}
        (output / "subreaper.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if survivors:
            raise RuntimeError(f"owned automation processes survived: {survivors}")
    return 128 + interrupted[0] if interrupted else (result if result is not None and result >= 0 else 1)


if __name__ == "__main__":
    raise SystemExit(main())
