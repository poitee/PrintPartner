"""Verify the fixed Sponsor handoff in pp-desktop with a recording OS opener.

Run under dbus-run-session -- xvfb-run -a with a staged desktop runtime.
"""

import argparse
import base64
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


SPONSOR = "https://github.com/sponsors/poitee"


def wait_for(check, label, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}")


def verify(binary, stage, output, enabled):
    with tempfile.TemporaryDirectory(prefix="pp-native-sponsor-") as temporary:
        root = Path(temporary)
        record = root / "opened.jsonl"
        shim = root / "bin"
        shim.mkdir()
        opener = shim / "xdg-open"
        opener.write_text(
            "#!/usr/bin/python3\nimport json, os, sys\n"
            "with open(os.environ['PP_SPONSOR_RECORD'], 'a') as out:\n"
            "    out.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        )
        opener.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        environment = dict(
            os.environ,
            PATH=f"{shim}:{os.environ['PATH']}",
            PP_SPONSOR_RECORD=str(record),
            PP_DESKTOP_REBUILD="1" if enabled else "0",
            PP_DESKTOP_RELEASE_MANIFEST=str(stage / "bundle-manifest.json"),
            TAURI_WEBVIEW_AUTOMATION="true",
            XDG_DATA_HOME=str(root / "xdg-data"),
            XDG_CACHE_HOME=str(root / "xdg-cache"),
        )
        session = None
        phase = "enabled" if enabled else "disabled"
        with (output / f"{phase}-driver.log").open("w") as log:
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

            def execute(script, *args, asynchronous=False):
                suffix = "async" if asynchronous else "sync"
                return command(f"/session/{session}/execute/{suffix}", {"script": script, "args": list(args)})

            def opened():
                return [json.loads(line) for line in record.read_text().splitlines()] if record.exists() else []

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
                assert execute("return typeof window.__PRINT_PARTNER_NATIVE_SPONSOR__ === 'function';") is enabled
                original = execute("return location.href;")
                execute("window.open(arguments[0], '_blank', 'noopener,noreferrer'); return true;", SPONSOR)
                time.sleep(0.5)
                assert opened() == [], "Popup must not dispatch a browser action"
                assert len(command(f"/session/{session}/window/handles")) == 1
                assert execute("return location.href;") == original
                denied = []
                names = ["plugin:app|exit", "plugin:window|close", "plugin:webview|create_webview_window", "plugin:fs|read_file", "plugin:shell|execute", "plugin:opener|open_url", "open_url"]
                if not enabled:
                    names.append("open_sponsor")
                for name in names:
                    outcome = execute("""
const done = arguments[arguments.length - 1];
window.__TAURI_INTERNALS__.invoke(arguments[0], {}).then(
  () => done({allowed:true}), error => done({allowed:false, reason:String(error)}));
""", name, asynchronous=True)
                    assert outcome.get("allowed") is False, (name, outcome)
                    denied.append(name)
                if enabled:
                    element = execute("""
return [...document.querySelectorAll('button')].find(button =>
  button.textContent.trim() === 'Sponsor' && button.getClientRects().length);
""")
                    assert element, "Visible production Sponsor button missing"
                    command(f"/session/{session}/element/{element['element-6066-11e4-a52e-4f735466cecf']}/click", {})
                    wait_for(lambda: len(opened()) == 1, "native Sponsor opener")
                    assert opened() == [[SPONSOR]], opened()
                    time.sleep(0.5)
                    assert opened() == [[SPONSOR]], "One click must dispatch exactly once"
                else:
                    assert opened() == []
                (output / f"{phase}.png").write_bytes(base64.b64decode(command(f"/session/{session}/screenshot")))
                return {"enabled": enabled, "popup_dispatched": False, "denied_commands": denied, "opener_arguments": opened()}
            finally:
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
    results = [verify(args.binary.resolve(strict=True), args.stage.resolve(strict=True), args.output, enabled) for enabled in [False, True]]
    (args.output / "sponsor.json").write_text(json.dumps(results, indent=2) + "\n")
    print("PASS: disabled native action, denied popups and privileged IPC, fixed Sponsor click")


if __name__ == "__main__":
    main()
