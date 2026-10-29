"""Verify pp-desktop's download policy in the real WebKitGTK webview.

Run under dbus-run-session -- xvfb-run -a with a staged desktop runtime.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def wait_for(check, label, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}")


CLICK = """
const [href, name] = arguments;
const anchor = document.createElement('a');
anchor.href = href;
anchor.download = name;
document.body.append(anchor);
anchor.click();
anchor.remove();
return true;
"""

BLOB = """
const [text] = arguments;
return URL.createObjectURL(new Blob([text], {type: 'text/plain'}));
"""


def verify(binary, stage, output):
    with tempfile.TemporaryDirectory(prefix="pp-native-downloads-") as temporary:
        root = Path(temporary)
        home = root / "home"
        downloads = home / "Downloads"
        downloads.mkdir(parents=True)
        config = root / "xdg-config"
        config.mkdir()
        (config / "user-dirs.dirs").write_text(f'XDG_DOWNLOAD_DIR="{downloads}"\n')
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        environment = dict(
            os.environ,
            HOME=str(home),
            PP_DESKTOP_RELEASE_MANIFEST=str(stage / "bundle-manifest.json"),
            TAURI_WEBVIEW_AUTOMATION="true",
            XDG_CONFIG_HOME=str(config),
            XDG_DATA_HOME=str(root / "xdg-data"),
            XDG_CACHE_HOME=str(root / "xdg-cache"),
        )
        session = None
        with (output / "driver.log").open("w") as log:
            driver = subprocess.Popen(
                ["WebKitWebDriver", f"--port={port}", "--host=127.0.0.1"],
                env=environment, stdout=log, stderr=log, start_new_session=True,
            )

            def command(path, body=None, method=None):
                request = urllib.request.Request(
                    base + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={"Content-Type": "application/json"}, method=method,
                )
                with urllib.request.urlopen(request, timeout=90) as response:
                    value = json.load(response)["value"]
                if isinstance(value, dict) and value.get("error"):
                    raise AssertionError(value)
                return value

            def execute(script, *args):
                return command(f"/session/{session}/execute/sync", {"script": script, "args": list(args)})

            def saved():
                return sorted(path.name for path in downloads.iterdir() if not path.name.endswith(".wkdownload"))

            def ready():
                assert driver.poll() is None, "WebKitWebDriver exited"
                try:
                    return command("/status")["ready"]
                except urllib.error.URLError:
                    return False

            try:
                wait_for(ready, "WebKitWebDriver")
                result = command("/session", {"capabilities": {"alwaysMatch": {
                    "webkitgtk:browserOptions": {"binary": str(binary), "args": [
                        "--dev-stage", str(stage), "--data", str(root / "data"),
                    ]},
                    "timeouts": {"script": 15000, "pageLoad": 60000, "implicit": 0},
                }}})
                session = result["sessionId"]
                wait_for(lambda: execute("return location.pathname === '/builds' && !!document.querySelector('#root');"), "desktop launch")
                original = execute("return location.href;")
                origin = execute("return location.origin;")

                # wry's default placement checks exists(), which follows this
                # dangling link and would write through it, outside Downloads.
                outside = root / "outside-target.json"
                (downloads / "escape.json").symlink_to(outside)
                expected = ["escape (1).json", "escape (2).json", "escape.json"]

                execute(CLICK, f"{origin}/legal/summary", "../../escape.json")
                wait_for(lambda: saved() == expected[:1] + expected[2:], "same-origin URL download")
                body = (downloads / "escape (1).json").read_bytes()
                assert body, "empty download"

                execute(CLICK, f"{origin}/legal/summary", "escape.json")
                wait_for(lambda: saved() == expected, "renamed second download")
                assert (downloads / "escape (1).json").read_bytes() == body
                assert not outside.exists(), "download wrote through the planted symlink"

                execute(CLICK, "data:text/plain,data-body", "data.txt")
                # WebKitGTK sends <a download> through the navigation check first,
                # which rejects blob: documents, so a blob download saves nothing.
                execute(CLICK, execute(BLOB, "blob-body"), "blob.txt")
                time.sleep(2)
                assert saved() == expected, saved()

                stray = sorted(
                    str(path.relative_to(root)) for path in root.rglob("*")
                    if (path.name.startswith(("escape", "outside-target")) or path.name in ("data.txt", "blob.txt")) and path.parent != downloads
                )
                assert stray == [], stray
                assert execute("return location.href;") == original
                assert len(command(f"/session/{session}/window/handles")) == 1
                return {"saved": saved(), "data_and_blob_saved": False, "outside_downloads": stray}
            finally:
                for path in (root / "data").rglob("*.log"):
                    (output / path.name).write_bytes(path.read_bytes())
                if session:
                    try:
                        command(f"/session/{session}", method="DELETE")
                    except (OSError, AssertionError):
                        pass
                try:
                    os.killpg(driver.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    driver.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(driver.pid, signal.SIGKILL)
                    driver.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result = verify(args.binary.resolve(strict=True), args.stage.resolve(strict=True), args.output)
    (args.output / "downloads.json").write_text(json.dumps(result, indent=2) + "\n")
    print("PASS: same-origin downloads land in Downloads under one unused name, never through a planted symlink; data: and blob: save nothing")


if __name__ == "__main__":
    main()
