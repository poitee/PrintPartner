import argparse
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time


parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=pathlib.Path, required=True)
parser.add_argument("--stage", type=pathlib.Path, required=True)
parser.add_argument("--receipt", type=pathlib.Path, required=True)
args = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[2]
head = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
fixture = pathlib.Path(tempfile.mkdtemp(prefix="pp-recovery-probe-"))
data = fixture / "data"
(data / "logs").mkdir(parents=True)
(data / "logs/desktop.jsonl").write_text(json.dumps({
    "time": 1, "level": 50, "event": "compat_failure", "reason": "child_exit",
    "termination": {"kind": "exit_code", "value": 7},
    "message": "GRE333_PROBE_PRIVATE_SENTINEL",
}) + "\n")
environment = {
    **os.environ,
    "PP_DESKTOP_RECOVERY_UI": "1",
    "WEBKIT_DISABLE_COMPOSITING_MODE": "1",
    "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM": "1",
    "WEBKIT_SKIA_ENABLE_CPU_RENDERING": "1",
    "LIBGL_ALWAYS_SOFTWARE": "1",
}
command = [str(args.binary.resolve(strict=True)), "--dev-stage",
           str(args.stage.resolve(strict=True)), "--data", str(data),
           "--test-exit-seconds", "3", "--test-recovery-logs"]
process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, start_new_session=True)
stdout = ""
stderr = ""
window = None
try:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and process.poll() is None:
        search = subprocess.run(["xdotool", "search", "--all", "--onlyvisible",
                                 "--pid", str(process.pid), "--name", "^Service logs$"],
                                capture_output=True, text=True, timeout=3)
        windows = search.stdout.split()
        if windows:
            assert len(windows) == 1, windows
            window = windows[0]
            subprocess.run(["import", "-window", window,
                            str(args.receipt.with_suffix(".png"))], check=True, timeout=5)
            break
        time.sleep(0.1)
    assert window is not None, "Service logs dialog did not become visible"
    stdout, stderr = process.communicate(timeout=25)
    assert process.returncode == 0, {"exit": process.returncode, "stderr": stderr[-1000:]}
    records = [json.loads(row) for row in stdout.splitlines()]
    receipt = records[-1]
    assert all(receipt[key] for key in ["compat_reaped", "storage_released",
                                      "gateway_stopped", "marker_removed", "runtime_removed"]), receipt
    assert receipt["errors"] == [], receipt
    native = next(row["native_window"] for row in records if "native_window" in row)
    assert native == {"close_hid": True, "show_visible": True}, native
    assert not (data / ".desktop-owner.json").exists()
    assert "GRE333_PROBE_PRIVATE_SENTINEL" not in stdout + stderr
    args.receipt.write_text(json.dumps({
        "source_head": head,
        "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        "manifest_sha256": hashlib.sha256((args.stage / "bundle-manifest.json").read_bytes()).hexdigest(),
        "proof_class": "native_linux_recovery_dialog", "fixture": str(fixture),
        "window": window, "dialog_left_open_during_shutdown": True,
        "exit_code": process.returncode, "shutdown": receipt, "native_window": native,
        "screenshot": str(args.receipt.with_suffix(".png")), "macos": False,
    }, indent=2) + "\n")
    print(args.receipt.read_text())
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    args.receipt.with_suffix(".stdout.log").write_text(stdout)
    args.receipt.with_suffix(".stderr.log").write_text(stderr)
