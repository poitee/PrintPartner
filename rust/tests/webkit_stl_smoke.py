"""Exercise the real pp-desktop WebKitGTK viewer; run under dbus-run-session/xvfb-run.

Only Python's standard library and the distro WebKitWebDriver are needed.
TAURI_WEBVIEW_AUTOMATION is supported by the pinned tauri-runtime-wry.
"""

import argparse
import base64
import hashlib
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


ROOT = Path(__file__).resolve().parents[2]

SEED = r"""
const [encoded, filename, done] = arguments;
(async () => {
  async function api(path, method = 'GET', body, headers = {}) {
    if (body && !(body instanceof FormData)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, {method, body, headers});
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const source = await api('/sources', 'POST', {name: 'WebKitGTK smoke', source_kind: 'local'});
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const upload = new FormData();
  upload.append('files', new Blob([bytes]), filename);
  upload.append('relative_paths', JSON.stringify([filename]));
  await api(`/sources/${source.id}/upload-files`, 'POST', upload);
  const plan = await api('/plans', 'POST', {name: 'WebKitGTK known mesh'});
  await api(`/plans/${plan.id}/layers/base`, 'PUT', {project_id: source.id});
  const workspace = await api(`/plans/${plan.id}/drafts/recompute`, 'POST',
    {apply_manifest: true}, {'Idempotency-Key': 'webkit-smoke-prepare'});
  const draft = workspace.draft;
  await api(`/plans/${plan.id}/drafts/${draft.draft_id}/apply`, 'POST', {
    expected_snapshot_digest: draft.snapshot_digest,
    expected_lifecycle_version: draft.lifecycle_version, expected_base: draft.base,
  }, {'Idempotency-Key': 'webkit-smoke-publish'});
  // Observe the bytes consumed by the production viewer without replacing its response.
  const originalFetch = window.fetch;
  window.__smokeMesh = {matched: false};
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0].url;
    if (/\/mesh(?:\?|$)/.test(url)) {
      const actual = new Uint8Array(await response.clone().arrayBuffer());
      window.__smokeMesh = {url, matched: response.ok && actual.length === bytes.length &&
        actual.every((v, i) => v === bytes[i])};
    }
    return response;
  };
  history.pushState({}, '', `/plan?profile=${plan.id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
  done({source_id: source.id, plan_id: plan.id});
})().catch(error => done({error: String(error)}));
"""

PIXELS = r"""
const done = arguments[arguments.length - 1];
// Sample within a frame: Three uses preserveDrawingBuffer=false. Reading after
// compositing would produce a cleared buffer even when the mesh is visible.
requestAnimationFrame(() => {
  try {
    const canvas = document.querySelector('[role="dialog"] canvas');
    if (!canvas) return done({error: 'No viewer canvas (PNG fallback is not a pass)'});
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl || gl.isContextLost()) return done({error: 'No live WebGL context'});
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const error = gl.getError();
    const colors = new Set();
    let visible = 0, centerVisible = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128 && Math.max(data[i], data[i+1], data[i+2]) > 15) {
        visible++;
        colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);
        if (x > width*.25 && x < width*.75 && y > height*.25 && y < height*.75) centerVisible++;
      }
    }
    done({webgl: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER),
      width, height, gl_error: error, visible_pixels: visible, center_visible_pixels: centerVisible,
      unique_colors: colors.size, mesh: window.__smokeMesh,
      canvas_png: canvas.toDataURL('image/png')});
  } catch (error) { done({error: String(error)}); }
});
"""


def wait_for(check, label, seconds=45):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(0.25)
    raise AssertionError(f"Timed out: {label}; last result={last!r}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'rust/target/debug/pp-desktop')
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    stage = args.stage.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    session = None
    with tempfile.TemporaryDirectory(prefix='pp-webkit-smoke-') as temporary:
        data = Path(temporary) / 'data'
        env = dict(os.environ, TAURI_WEBVIEW_AUTOMATION='true')
        # Keep WebKit browser storage isolated as well as the product database.
        env['XDG_DATA_HOME'] = str(Path(temporary) / 'xdg-data')
        env['XDG_CACHE_HOME'] = str(Path(temporary) / 'xdg-cache')
        with (output / 'desktop-driver.log').open('w') as log:
            driver = subprocess.Popen(['WebKitWebDriver', f'--port={port}', '--host=127.0.0.1'],
                                      env=env, stdout=log, stderr=log, start_new_session=True)

            def command(path, body=None, method=None):
                request = urllib.request.Request(base + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={'Content-Type': 'application/json'}, method=method)
                try:
                    with urllib.request.urlopen(request, timeout=90) as response:
                        value = json.load(response)['value']
                except urllib.error.HTTPError as error:
                    raise AssertionError(f'WebDriver {path}: {error.read().decode()}') from error
                if isinstance(value, dict) and value.get('error'):
                    raise AssertionError(value)
                return value

            def execute(script, *values, asynchronous=False):
                return command(f'/session/{session}/execute/{"async" if asynchronous else "sync"}',
                               {'script': script, 'args': list(values)})

            def ready():
                if driver.poll() is not None:
                    raise AssertionError('WebKitWebDriver exited; see desktop-driver.log')
                try:
                    return command('/status')['ready']
                except urllib.error.URLError:
                    return False

            try:
                wait_for(ready, 'WebKitWebDriver readiness')
                result = command('/session', {'capabilities': {'alwaysMatch': {
                    'webkitgtk:browserOptions': {'binary': str(binary),
                        'args': ['--dev-stage', str(stage), '--data', str(data)]},
                    'timeouts': {'script': 60000, 'pageLoad': 60000, 'implicit': 0},
                }}})
                session = result['sessionId']
                wait_for(lambda: execute("return location.pathname === '/builds' && !!document.querySelector('#root');"),
                         'authenticated native launch')
                fixture = (ROOT / 'rust/tests/fixtures/part.stl').read_bytes()
                filename = 'webkit-known-mesh.stl'
                seeded = execute(SEED, base64.b64encode(fixture).decode(), filename, asynchronous=True)
                selector = f'button[aria-label="Preview 3D model of {filename}"]'
                element = wait_for(lambda: command(f'/session/{session}/elements',
                    {'using': 'css selector', 'value': selector}), 'Plan preview button')[0]
                element_id = element['element-6066-11e4-a52e-4f735466cecf']
                command(f'/session/{session}/element/{element_id}/click', {})
                wait_for(lambda: execute("return !!document.querySelector('[role=dialog] canvas');"),
                         'production STL WebGL canvas')
                pixels = execute(PIXELS, asynchronous=True)
                canvas_png = pixels.pop('canvas_png')
                (output / 'viewer-canvas.png').write_bytes(base64.b64decode(canvas_png.split(',', 1)[1]))
                (output / 'desktop-viewer.png').write_bytes(base64.b64decode(command(f'/session/{session}/screenshot')))
                (output / 'pixels.json').write_text(json.dumps(pixels, indent=2) + '\n')
                assert pixels['mesh']['matched'], pixels
                assert pixels['gl_error'] == 0, pixels
                assert pixels['width'] >= 100 and pixels['height'] >= 100, pixels
                assert pixels['visible_pixels'] > 1000 and pixels['center_visible_pixels'] > 1000, pixels
                assert pixels['unique_colors'] > 32, pixels
                receipt = {'result': 'PASS', 'proof_class': 'native_linux_webkitgtk_webgl',
                    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                    'capabilities': result['capabilities'], 'fixture_sha256': hashlib.sha256(fixture).hexdigest(),
                    **seeded, **pixels}
                (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                print(json.dumps(receipt), flush=True)
            except Exception:
                if session:
                    try:
                        (output / 'failure.png').write_bytes(base64.b64decode(command(f'/session/{session}/screenshot')))
                        (output / 'failure-ui.txt').write_text(execute('return document.body.innerText;'))
                    except Exception:
                        pass
                raise
            finally:
                # WebDriver closes the window, but this app hides on close. Stop
                # only the native child launched by this driver, allowing core cleanup.
                children_file = Path(f'/proc/{driver.pid}/task/{driver.pid}/children')
                if children_file.exists():
                    for child in children_file.read_text().split():
                        try:
                            if Path(f'/proc/{child}/exe').resolve() == binary:
                                os.kill(int(child), signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                try:
                    if data.exists():
                        wait_for(lambda: not (data / '.desktop-owner.json').exists(), 'desktop shutdown', 20)
                    if session:
                        try:
                            command(f'/session/{session}', method='DELETE')
                        except (AssertionError, urllib.error.URLError):
                            pass
                finally:
                    try:
                        os.killpg(driver.pid, signal.SIGTERM)
                        driver.wait(timeout=10)
                    except ProcessLookupError:
                        pass
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL)
                        driver.wait(timeout=10)


if __name__ == '__main__':
    main()
