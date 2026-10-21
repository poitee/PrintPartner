"""Exercise the real pp-desktop WebKitGTK viewer; run under dbus-run-session/xvfb-run.

Only Python's standard library and the distro WebKitWebDriver are needed.
TAURI_WEBVIEW_AUTOMATION is supported by the pinned tauri-runtime-wry.
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

from webkit_diagnostics import CAPTURE_PREVIEW, INSTALL, best_effort, save_artifacts


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
  done({source_id: source.id, plan_id: plan.id});
})().catch(error => done({error: String(error)}));
"""

OBSERVE_MESH = r"""
  // Observe the bytes consumed by the production viewer without replacing its response.
  const bytes = Uint8Array.from(atob(arguments[0]), c => c.charCodeAt(0));
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


def verify_native_permissions(execute, screenshot, output):
    # Registered core commands must reach ACL rejection. Missing plugins are
    # recorded separately; their absence is not a core permission denial.
    commands = [
        ('plugin:app|exit', {'code': 0}, 'core:app:allow-exit'),
        ('plugin:window|close', {'label': 'main'}, 'core:window:allow-close'),
        ('plugin:window|destroy', {'label': 'main'}, 'core:window:allow-destroy'),
        ('plugin:webview|create_webview_window', {'options': {
            'label': 'permission-probe', 'url': 'https://example.com/'}},
         'core:webview:allow-create-webview-window'),
        ('plugin:fs|read_file', {'path': '/permission-probe'}, None),
        ('plugin:shell|execute', {'program': 'permission-probe', 'args': []}, None),
    ]
    proof = {'result': 'FAIL', 'commands': []}

    def save():
        (output / 'native-permissions.json').write_text(json.dumps(proof, indent=2) + '\n')

    token = os.urandom(16).hex()
    parent = execute(r'''
const token = arguments[0];
if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function')
  throw Error('native_invoke_missing');
window.__permissionProbe = {document, root: document.querySelector('#root'), href: location.href, token};
return {origin: location.origin, global_api_absent: window.__TAURI__ === undefined,
  labels: window.__TAURI_INTERNALS__.metadata};
''', token)
    proof['parent'] = parent
    save()
    assert parent['global_api_absent'] is True, parent
    assert parent['labels']['currentWindow']['label'] == 'main', parent
    assert parent['labels']['currentWebview']['label'] == 'main', parent
    for command, payload, permission in commands:
        observed = execute(r'''
const [command, payload, done] = arguments;
let settled = false;
const timer = setTimeout(() => {if (!settled) {settled = true; done({status:'timeout'});}}, 5000);
window.__TAURI_INTERNALS__.invoke(command, payload).then(() => {
  if (!settled) {settled = true; clearTimeout(timer); done({status:'resolved'});}
}, error => {
  if (!settled) {settled = true; clearTimeout(timer); done({status:'rejected', rejection_message:String(error)});}
});
''', command, payload, asynchronous=True)
        proof['commands'].append({'command': command, 'expected_permission': permission, **observed})
        save()
        assert observed['status'] == 'rejected', observed
        pretty = command.removeprefix('plugin:').replace('|', '.')
        assert observed['rejection_message'].startswith(pretty + ' not allowed.'), observed
        if permission:
            assert 'Permissions associated with this command:' in observed['rejection_message'], observed
            assert permission in observed['rejection_message'], observed
            assert 'not found' not in observed['rejection_message'], observed
        else:
            assert observed['rejection_message'] == pretty + ' not allowed. Plugin not found', observed
    proof['after'] = execute(r'''
const state = window.__permissionProbe;
return {document_preserved: state.document === document, root_preserved: state.root === document.querySelector('#root'),
  url_preserved: state.href === location.href, token_preserved: state.token === arguments[0]};
''', token)
    save()
    assert all(value is True for value in proof['after'].values()), proof
    (output / 'native-permissions-denied.png').write_bytes(base64.b64decode(screenshot()))
    execute('delete window.__permissionProbe;')
    proof['result'] = 'PASS'
    save()
    return proof


def verify_navigation(execute, screenshot, output):
    token = os.urandom(16).hex()
    source = execute('return {origin: location.origin, href: location.href};')
    assert source['href'] == source['origin'] + '/builds', 'Expected authenticated builds document'
    proof = {'source_url': source['href'], 'sample_count': 0}

    def save():
        (output / 'navigation.json').write_text(json.dumps(proof, indent=2) + '\n')

    created = execute(r"""
const [token, done] = arguments;
window.__navigationDocumentToken = token;
sessionStorage.removeItem('pp-native-blob-executed');
const html = `<body data-native-blob-probe="${token}">native blob probe
<script>window.__nativeBlobExecuted = '${token}';
try { sessionStorage.setItem('pp-native-blob-executed', '${token}'); } catch (error) {}<\/script>`;
const blob = new Blob([html], {type: 'text/html'});
window.__navigationBlobUrl = URL.createObjectURL(blob);
fetch(window.__navigationBlobUrl).then(response => response.text()).then(text => done({
  blob_url: window.__navigationBlobUrl, blob_created: true, blob_type: blob.type,
  blob_origin_matches: new URL(window.__navigationBlobUrl).origin === location.origin,
  blob_bytes_match: text === html,
})).catch(error => done({error: String(error)}));
""", token, asynchronous=True)
    proof.update(created)
    save()
    assert created['blob_created'] and created['blob_type'] == 'text/html', proof
    assert created['blob_origin_matches'] and created['blob_bytes_match'], proof
    proof['attempt_scheduled'] = execute(r"""
const token = arguments[0];
setTimeout(() => {
  window.__navigationAttempted = token;
  location.assign(window.__navigationBlobUrl);
}, 50);
return true;
""", token)
    save()
    assert proof['attempt_scheduled'], proof

    def observe():
        observed = execute(r"""
const token = arguments[0];
let stored = null;
try { stored = sessionStorage.getItem('pp-native-blob-executed'); } catch (error) {}
return {final_href: location.href,
  attempt_observed: window.__navigationAttempted === token,
  document_preserved: window.__navigationDocumentToken === token,
  root_present: !!document.querySelector('#root'),
  blob_document_seen: !!document.querySelector('[data-native-blob-probe]'),
  blob_script_executed: window.__nativeBlobExecuted === token || stored === token};
""", token)
        proof.update(observed)
        proof['sample_count'] += 1
        save()
        assert observed['final_href'] == source['href'], proof
        assert observed['document_preserved'] and observed['root_present'], proof
        assert not observed['blob_document_seen'] and not observed['blob_script_executed'], proof
        return observed['attempt_observed']

    wait_for(observe, 'blob navigation attempt marker', 5)
    started = time.monotonic()
    while time.monotonic() - started < 3:
        assert observe(), proof
        time.sleep(0.1)
    assert observe(), proof
    proof['observation_seconds'] = time.monotonic() - started
    (output / 'navigation-denied.png').write_bytes(base64.b64decode(screenshot()))
    execute('URL.revokeObjectURL(window.__navigationBlobUrl); delete window.__navigationBlobUrl;')
    control = source['origin'] + '/builds?navigation_control=' + token
    proof['http_control_url'] = control
    proof['http_control_scheduled'] = execute(r"""
const url = arguments[0];
setTimeout(() => location.assign(url), 50);
return true;
""", control)
    save()
    assert proof['http_control_scheduled'], proof

    def control_loaded():
        observed = execute(r"""
const [url, token] = arguments;
return {http_control_loaded: location.href === url && document.readyState === 'complete'
  && !!document.querySelector('#root') && window.__navigationDocumentToken !== token,
  http_control_blob_script_executed: sessionStorage.getItem('pp-native-blob-executed') === token};
""", control, token)
        proof.update(observed)
        save()
        assert not observed['http_control_blob_script_executed'], proof
        return observed['http_control_loaded']

    wait_for(control_loaded, 'same-origin HTTP document transition')
    execute("sessionStorage.removeItem('pp-native-blob-executed');")
    proof['result'] = 'PASS'
    save()
    return proof


FRAME_POLICY = "frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"


def frame_csp_enforced(observation):
    def origin(url):
        parsed = urllib.parse.urlsplit(url)
        return (parsed.scheme, parsed.hostname, parsed.port or 80)

    def policy(value):
        return ';'.join(' '.join(part.split()) for part in value.strip().removesuffix(';').split(';'))

    for event in observation['events']:
        if (event.get('isTrusted') is True and event.get('effectiveDirective') == 'frame-src'
                and event.get('disposition') == 'enforce'
                and origin(event.get('blockedURI', '')) == origin(observation['child_origin'])
                and urllib.parse.urldefrag(event.get('documentURI', ''))[0]
                    == urllib.parse.urldefrag(observation['parent_href'])[0]
                and policy(event.get('originalPolicy', '')) == policy(FRAME_POLICY)):
            return True
    return False


def frame_denial(observation):
    if not observation['attempt_intact']:
        return 'invalid_frame_attempt'
    if not observation['parent_preserved']:
        return 'parent_not_preserved'
    if observation['message'] or observation['beacon_count']:
        return 'target_executed'

    if not frame_csp_enforced(observation):
        return 'native_csp_enforcement_unproven' if observation['phase'] == 'native' else 'csp_enforcement_unproven'
    if observation['document_get_count']:
        return 'unexpected_child_document_get'
    return None


def verify_remote_frames(execute, screenshot, output, temporary, native_capabilities, binary):
    proof = {'policies': {'strict': FRAME_POLICY}, 'observations': {}, 'cleanup': {}}
    servers, threads = [], []
    driver = session = None
    routes, requests = {}, []
    lock = threading.Lock()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def save():
        (output / 'frames.json').write_text(json.dumps(proof, indent=2) + '\n')

    def linked_engine(executable):
        assert executable.is_file() and os.access(executable, os.X_OK), 'frame_control_binary_missing'
        linked = subprocess.check_output(['ldd', str(executable)], text=True, timeout=15)
        matches = [line.split('=>', 1)[1].strip().split()[0] for line in linked.splitlines()
                   if line.strip().startswith('libwebkit2gtk-4.1.so.0 =>')]
        assert len(matches) == 1, 'frame_engine_library_missing'
        library = Path(matches[0]).resolve(strict=True)
        return {'path': str(library), 'sha256': hashlib.sha256(library.read_bytes()).hexdigest()}

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def log_message(self, *args):
            pass

        def do_GET(self):
            with lock:
                route = routes.get((self.server.server_port, self.path))
                if len(requests) >= 256:
                    self.send_error(429)
                    return
                requests.append({'route': route['label'] if route else 'unknown',
                                 'time': time.monotonic()})
            body = route['body'] if route else b'not found'
            self.send_response(route['status'] if route else 404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            if route and route.get('policy'):
                self.send_header('Content-Security-Policy', route['policy'])
            if route and route.get('origin'):
                self.send_header('Access-Control-Allow-Origin', route['origin'])
            self.end_headers()
            self.wfile.write(body)

    def register(server, path, label, body, policy=None, origin=None, status=200):
        with lock:
            routes[(server.server_port, path)] = dict(label=label, body=body, policy=policy,
                                                     origin=origin, status=status)
        return f'http://127.0.0.1:{server.server_port}{path}'

    def control_command(path, body=None, method=None):
        request = urllib.request.Request(control_base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'}, method=method)
        with opener.open(request, timeout=20) as response:
            value = json.load(response)['value']
        assert not (isinstance(value, dict) and value.get('error')), value
        return value

    def control_execute(script, *values, asynchronous=False):
        return control_command(f'/session/{session}/execute/{"async" if asynchronous else "sync"}',
                               {'script': script, 'args': list(values)})

    def observe(run, capture, phase):
        token = os.urandom(16).hex()
        parent = run('return {href: location.href, origin: location.origin};')
        assert urllib.parse.urlsplit(parent['href']).scheme == 'http', 'invalid_parent_scheme'
        assert parent['origin'] != child_origin, 'frame_target_not_cross_origin'
        body = ('<body>frame target<script>fetch(' + json.dumps('/executed/' + token)
                + ', {credentials:"omit"});parent.postMessage({kind:"pp-frame-executed",token:'
                + json.dumps(token) + '},' + json.dumps(parent['origin']) + ');</script>').encode()
        target = register(servers[1], '/child/' + token, phase + '-document', body, origin=parent['origin'])
        register(servers[1], '/executed/' + token, phase + '-beacon', b'', status=204)
        observation = {'phase': phase, 'parent_href': parent['href'], 'parent_origin': parent['origin'],
                       'target_url': target, 'attempt_token': token, 'child_origin': child_origin,
                       'events': [], 'sample_count': 0}
        proof['observations'][phase] = observation
        save()
        with opener.open(target, timeout=5) as response:
            assert response.status == 200 and response.geturl() == target
            assert response.headers.get_content_type() == 'text/html' and response.read() == body
            assert not response.headers.get('X-Frame-Options') and not response.headers.get('Content-Security-Policy')
        fetched = run(r"""
const [url, expected, done] = arguments;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5000);
fetch(url, {credentials:'omit', cache:'no-store', signal:controller.signal})
.then(async r => done({ok:r.status === 200 && r.url === url &&
 r.headers.get('content-type') === 'text/html; charset=utf-8' && await r.text() === expected}))
.catch(e => done({error:String(e)})).finally(() => clearTimeout(timer));
""", target, body.decode(), asynchronous=True)
        assert fetched == {'ok': True}, fetched
        observation['preflight'] = {'python': True, 'browser_credentials_omit': True}
        with lock:
            baseline = len(requests)
        key = '__frame_' + token
        try:
            run(r"""
const [key, token, target] = arguments;
const state = {doc:document, root:document.querySelector('#root'), href:location.href,
 token, events:[], message:false};
if (!state.root) throw Error('frame_parent_root_missing');
window[key] = state; document[key] = token;
state.frame = document.createElement('iframe'); state.frame.src = target;
state.csp = e => {if (state.events.length < 16) state.events.push({isTrusted:e.isTrusted,
 effectiveDirective:e.effectiveDirective, violatedDirective:e.violatedDirective,
 disposition:e.disposition, blockedURI:e.blockedURI, documentURI:e.documentURI,
 originalPolicy:e.originalPolicy, timeStamp:e.timeStamp});};
state.receive = e => {if (e.origin === new URL(target).origin &&
 e.source === state.frame.contentWindow && e.data && e.data.kind === 'pp-frame-executed'
 && e.data.token === token) state.message = true;};
addEventListener('securitypolicyviolation', state.csp); addEventListener('message', state.receive);
document.body.append(state.frame); return true;
""", key, token, target)
            started = time.monotonic()
            event_seen = None
            observation.update(attempt_intact=True, parent_preserved=True)
            while time.monotonic() - started < 8:
                sample = run(r"""
const [key, token, target] = arguments, s = window[key];
if (!s) throw Error('frame_observer_lost');
return {attempt_intact:s.frame.isConnected && s.frame.ownerDocument === document &&
 s.frame.src === target && !s.frame.hasAttribute('sandbox') && !s.frame.hasAttribute('srcdoc') &&
 s.frame.loading !== 'lazy', parent_preserved:s.doc === document && s.root === document.querySelector('#root')
 && document[key] === token && s.token === token && location.href === s.href,
 message:s.message, events:s.events};
""", key, token, target)
                assert set(sample) == {'attempt_intact', 'parent_preserved', 'message', 'events'}, sample
                assert all(type(sample[k]) is bool for k in ('attempt_intact', 'parent_preserved', 'message'))
                for event in sample['events']:
                    assert set(event) == {'isTrusted', 'effectiveDirective', 'violatedDirective',
                        'disposition', 'blockedURI', 'documentURI', 'originalPolicy', 'timeStamp'}, 'unsupported_csp_event_observation'
                observation['attempt_intact'] &= sample['attempt_intact']
                observation['parent_preserved'] &= sample['parent_preserved']
                observation.update(message=sample['message'], events=sample['events'])
                observation['sample_count'] += 1
                observation['duration_seconds'] = time.monotonic() - started
                if frame_csp_enforced(observation) and event_seen is None:
                    event_seen = time.monotonic()
                save()
                if observation['duration_seconds'] >= 3 and (event_seen is None or time.monotonic() - event_seen >= 3):
                    break
                time.sleep(0.1)
            assert observation['duration_seconds'] >= 3
            if event_seen is not None:
                observation['seconds_after_enforcing_event'] = time.monotonic() - event_seen
                assert observation['seconds_after_enforcing_event'] >= 3, 'frame_event_observation_too_short'
            with lock:
                observation['request_delta'] = list(requests[baseline:])
            observation['document_get_count'] = sum(r['route'] == phase + '-document' for r in observation['request_delta'])
            observation['beacon_count'] = sum(r['route'] == phase + '-beacon' for r in observation['request_delta'])
            save()
            (output / f'frames-{phase}.png').write_bytes(base64.b64decode(capture()))
            return observation
        finally:
            run("const s=window[arguments[0]]; if(s){removeEventListener('securitypolicyviolation',s.csp);"
                "removeEventListener('message',s.receive);s.frame.remove();delete document[arguments[0]];"
                "delete window[arguments[0]];} return true;", key)

    def require_execution(observation):
        assert observation['attempt_intact'] and observation['parent_preserved'], observation
        assert observation['message'] and observation['beacon_count'] > 0 and observation['document_get_count'] > 0, 'frame_control_execution_unproven'

    save()
    try:
        mini = Path('/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser')
        proof['engine'] = {'native': linked_engine(binary), 'control': linked_engine(mini),
                           'native_capabilities': native_capabilities}
        assert proof['engine']['native'] == proof['engine']['control'], 'frame_engine_mismatch'
        for _ in range(2):
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            server.daemon_threads = True
            servers.append(server)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            threads.append(thread)
            thread.start()
        child_origin = f'http://127.0.0.1:{servers[1].server_port}'
        relaxed = FRAME_POLICY.replace("frame-src 'none'", 'frame-src ' + child_origin, 1)
        proof['policies']['relaxed'] = relaxed
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        control_base = f'http://127.0.0.1:{port}'
        environment = dict(os.environ, XDG_DATA_HOME=str(Path(temporary) / 'frame-data'),
                           XDG_CACHE_HOME=str(Path(temporary) / 'frame-cache'))
        environment.pop('TAURI_WEBVIEW_AUTOMATION', None)
        with (output / 'frames-control-driver.log').open('w') as log:
            driver = subprocess.Popen(['WebKitWebDriver', f'--port={port}', '--host=127.0.0.1'],
                env=environment, stdout=log, stderr=log, start_new_session=True)
        def ready():
            assert driver.poll() is None, 'frame_control_driver_exited'
            try:
                return control_command('/status')['ready']
            except urllib.error.URLError:
                return False
        wait_for(ready, 'frame control driver', 15)
        result = control_command('/session', {'capabilities': {'alwaysMatch': {
            'webkitgtk:browserOptions': {'binary': str(mini), 'args': ['--automation']},
            'timeouts': {'script': 15000, 'pageLoad': 15000, 'implicit': 0}}}})
        session = result['sessionId']
        proof['engine']['control_capabilities'] = result['capabilities']
        for phase, policy in [('positive', relaxed), ('strict', FRAME_POLICY), ('negative', relaxed)]:
            parent_url = register(servers[0], '/' + phase, phase + '-parent', b'<body><div id="root">frame parent</div>', policy)
            with opener.open(parent_url, timeout=5) as response:
                assert response.headers['Content-Security-Policy'] == policy and response.status == 200
            control_command(f'/session/{session}/url', {'url': parent_url})
            wait_for(lambda: control_execute('return location.href === arguments[0] && document.readyState === "complete";', parent_url), 'control parent')
            observation = observe(control_execute, lambda: control_command(f'/session/{session}/screenshot'), phase)
            if phase != 'strict':
                require_execution(observation)
            reason = frame_denial(observation)
            observation['denial_result'] = reason
            save()
            assert reason == ('target_executed' if phase != 'strict' else None), reason
        native = observe(execute, screenshot, 'native')
        native['denial_result'] = frame_denial(native)
        save()
        assert native['denial_result'] is None, native['denial_result']
    finally:
        errors = []
        if session:
            try:
                control_command(f'/session/{session}', method='DELETE')
            except Exception as error:
                errors.append('control_session_cleanup: ' + str(error))
        if driver:
            try:
                os.killpg(driver.pid, signal.SIGTERM)
                try:
                    driver.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(driver.pid, signal.SIGKILL)
                    driver.wait(timeout=10)
                proof['cleanup']['control_driver_reaped'] = driver.poll() is not None
            except Exception as error:
                errors.append('control_process_cleanup: ' + str(error))
        for server, thread in zip(servers, threads):
            try:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                assert not thread.is_alive(), 'fixture_thread_still_alive'
            except Exception as error:
                errors.append('fixture_cleanup: ' + str(error))
        proof['cleanup']['fixture_threads_stopped'] = all(not thread.is_alive() for thread in threads)
        proof['cleanup']['errors'] = errors
        save()
        assert not errors, errors
    proof['result'] = 'PASS'
    save()
    return proof


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
                                      env=env, stdout=log, start_new_session=True)

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
                permissions = verify_native_permissions(execute,
                    lambda: command(f'/session/{session}/screenshot'), output)
                navigation = verify_navigation(execute,
                    lambda: command(f'/session/{session}/screenshot'), output)
                frames = verify_remote_frames(execute,
                    lambda: command(f'/session/{session}/screenshot'), output, temporary,
                    result['capabilities'], binary)
                fixture = (ROOT / 'rust/tests/fixtures/part.stl').read_bytes()
                filename = 'webkit-known-mesh.stl'
                encoded = base64.b64encode(fixture).decode()
                seeded = execute(SEED, encoded, filename, asynchronous=True)
                origin = execute('return location.origin;')
                # Reload to populate the UI's initial cached Build list with the
                # fixture; do not mutate React state or its query cache in the test.
                command(f'/session/{session}/url', {'url': f'{origin}/plan?profile={seeded["plan_id"]}'})
                best_effort(execute, INSTALL)
                selector = f'button[aria-label="Preview 3D model of {filename}"]'
                element = wait_for(lambda: command(f'/session/{session}/elements',
                    {'using': 'css selector', 'value': selector}), 'Plan preview button')[0]
                element_id = element['element-6066-11e4-a52e-4f735466cecf']
                best_effort(execute, CAPTURE_PREVIEW, 'selected', element, selector)
                execute(OBSERVE_MESH, encoded)
                best_effort(execute, CAPTURE_PREVIEW, 'before-click')
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
                # This fixture is a flat triangle: few solid colors are expected.
                # Require a substantial opaque mesh region and reject a uniform
                # clear/background covering the whole canvas.
                assert 1000 < pixels['visible_pixels'] < pixels['width'] * pixels['height'] * 0.8, pixels
                assert pixels['center_visible_pixels'] > 1000 and pixels['unique_colors'] > 1, pixels
                receipt = {'result': 'PASS', 'proof_class': 'native_linux_webkitgtk_webgl',
                    'native_permissions': permissions, 'navigation': navigation, 'remote_frames': frames,
                    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                    'capabilities': result['capabilities'], 'fixture_sha256': hashlib.sha256(fixture).hexdigest(),
                    **seeded, **pixels}
                save_artifacts(execute, None, output)
                (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                print(json.dumps(receipt), flush=True)
            except Exception as error:
                save_artifacts(execute,
                    lambda: command(f'/session/{session}/screenshot'), output, error)
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
