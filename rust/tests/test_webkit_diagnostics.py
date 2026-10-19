import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from webkit_diagnostics import CAPTURE_PREVIEW, COLLECT, INSTALL, best_effort, save_artifacts
from webkit_stl_smoke import wait_for


PAGE = b'''<body><button aria-label="Preview fixture">Preview</button><script>
window.forwarded = [];
for (const level of ['warn', 'error']) {
  const native = console[level];
  console[level] = function(...args) {
    forwarded.push({level, receiver: this === console, argc: args.length, same: args[1] === window.payload});
    if (args[0] === 'throw-original') throw Error('original-console-error');
    native.apply(this, args);
    return 'original-return';
  };
}
document.querySelector('button').onclick = () => {
  console.warn('preview warning'); console.error('preview error');
  setTimeout(() => { throw Error('fixture window error'); }, 0);
  Promise.reject('fixture rejection');
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  canvas.getContext('webgl');
  canvas.remove();
  window.__smokeMesh = {matched: false, url: '/fixture/mesh'};
};
</script>'''


class BrowserProof(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='webkit-diagnostics-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.output = Path(cls.temporary.name)
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.wfile.write(PAGE)

            def log_message(self, *args):
                pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.stop_server)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}'
        env = dict(os.environ, XDG_DATA_HOME=str(cls.output / 'data'),
                   XDG_CACHE_HOME=str(cls.output / 'cache'), XDG_CONFIG_HOME=str(cls.output / 'config'))
        env.pop('TAURI_WEBVIEW_AUTOMATION', None)
        cls.log = (cls.output / 'driver.log').open('w')
        cls.addClassCleanup(cls.log.close)
        cls.driver = subprocess.Popen(['WebKitWebDriver', f'--port={port}', '--host=127.0.0.1'],
            env=env, stdout=cls.log, stderr=cls.log, start_new_session=True)
        cls.addClassCleanup(cls.stop_driver)
        def ready():
            if cls.driver.poll() is not None:
                raise AssertionError((cls.output / 'driver.log').read_text())
            try:
                return cls.command('/status')['ready']
            except urllib.error.URLError:
                return False
        wait_for(ready, 'fixture driver', 15)
        result = cls.command('/session', {'capabilities': {'alwaysMatch': {
            'webkitgtk:browserOptions': {
                'binary': '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
                'args': ['--automation']}}}})
        cls.session = result['sessionId']

    @classmethod
    def stop_server(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    @classmethod
    def stop_driver(cls):
        try:
            if hasattr(cls, 'session'):
                cls.command(f'/session/{cls.session}', method='DELETE')
        finally:
            if cls.driver.poll() is None:
                os.killpg(cls.driver.pid, signal.SIGTERM)
                try:
                    cls.driver.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(cls.driver.pid, signal.SIGKILL)
                    cls.driver.wait(timeout=10)

    @classmethod
    def command(cls, path, body=None, method=None):
        request = urllib.request.Request(cls.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'}, method=method)
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.load(response)['value']
        if isinstance(value, dict) and value.get('error'):
            raise AssertionError(value)
        return value

    @classmethod
    def execute(cls, script, *args):
        return cls.command(f'/session/{cls.session}/execute/sync', {'script': script, 'args': list(args)})

    def setUp(self):
        self.command(f'/session/{self.session}/url', {'url': f'http://127.0.0.1:{self.server.server_port}/'})
        self.execute(INSTALL)

    def test_no_canvas_timeout_keeps_short_lived_gl_and_console(self):
        element = self.command(f'/session/{self.session}/element',
            {'using': 'css selector', 'value': 'button'})['element-6066-11e4-a52e-4f735466cecf']
        self.command(f'/session/{self.session}/element/{element}/click', {})
        wait_for(lambda: self.execute("return __smokeDiagnostics.events.some(e => e.kind === 'unhandledrejection');"), 'rejection')
        with self.assertRaisesRegex(AssertionError, 'Timed out: production STL WebGL canvas') as caught:
            wait_for(lambda: self.execute("return !!document.querySelector('[role=dialog] canvas');"),
                     'production STL WebGL canvas', .5)
        save_artifacts(self.execute, lambda: self.command(f'/session/{self.session}/screenshot'),
                       self.output, caught.exception)
        proof = json.loads((self.output / 'failure-diagnostics.json').read_text())
        self.assertEqual((proof['dialogs'], proof['canvases'], proof['dialogCanvases']), (0, 0, 0))
        self.assertEqual(proof['mesh'], {'matched': False, 'url': '/fixture/mesh'})
        self.assertTrue(proof['url'].startswith('http://127.0.0.1:'))
        self.assertIn('activeElement', proof)
        events = proof['diagnostics']['events']
        self.assertTrue({'console.warn', 'console.error', 'window.error', 'unhandledrejection',
                         'click', 'pointerdown', 'pointerup'} <= {e['kind'] for e in events})
        gl = next(e for e in events if e['kind'] == 'getContext')
        self.assertTrue(gl['available'])
        self.assertTrue(all(gl[k] for k in ('version', 'vendor', 'renderer')))
        self.assertTrue(any(e.get('target', '').find('Preview fixture') >= 0 for e in events))
        self.assertTrue((self.output / 'failure.png').read_bytes().startswith(b'\x89PNG'))
        save_artifacts(self.execute, None, self.output)
        self.assertEqual(json.loads((self.output / 'success-diagnostics.json').read_text())['outcome'], 'success')

    def test_forwarding_bounds_null_and_lost_context(self):
        result = self.execute(r'''
window.payload = {toString() { throw Error('unprintable'); }};
let result;
for (let i = 0; i < 100; i++) result = console.warn('x'.repeat(2000), payload, ...Array(12).fill('extra'));
let thrown;
try { console.error('throw-original'); } catch (e) { thrown = e.message; }
const canvas = document.createElement('canvas'); document.body.append(canvas);
canvas.getContext('2d'); const unavailable = canvas.getContext('webgl');
const live = document.createElement('canvas'); document.body.append(live);
const gl = live.getContext('webgl');
const loss = gl.getExtension('WEBGL_lose_context'); loss.loseContext();
canvas.dispatchEvent(new WebGLContextEvent('webglcontextcreationerror', {statusMessage:'fixture creation failure'}));
return {result, thrown, unavailable, forwarded};
''')
        self.assertEqual(result['result'], 'original-return')
        self.assertEqual(result['thrown'], 'original-console-error')
        self.assertIsNone(result['unavailable'])
        self.assertEqual(len(result['forwarded']), 101)
        self.assertTrue(all(e['receiver'] and e['same'] and e['argc'] == 14 for e in result['forwarded'][:100]))
        wait_for(lambda: self.execute("return __smokeDiagnostics.events.some(e => e.kind === 'webglcontextlost');"), 'context loss')
        self.execute("document.querySelectorAll('canvas')[1].getContext('webgl');")
        state = self.execute(COLLECT)['diagnostics']
        self.assertEqual(len(state['events']), 80)
        self.assertGreaterEqual(state['dropped'], 21)
        events = state['events']
        self.assertTrue(any(e.get('available') is False for e in events))
        self.assertTrue(any(e.get('lost') is True for e in events))
        self.assertTrue(any(e['kind'] == 'webglcontextcreationerror' for e in events))
        warning = next(e for e in events if e['kind'] == 'console.warn')
        self.assertEqual(list(map(len, warning['args'])), [500, 13, 5, 5, 5, 5, 5, 5])

    def select_preview(self):
        selector = 'button[aria-label="Preview fixture"]'
        element = self.command(f'/session/{self.session}/element',
            {'using': 'css selector', 'value': selector})
        best_effort(self.execute, CAPTURE_PREVIEW, 'selected', element, selector)
        return element['element-6066-11e4-a52e-4f735466cecf']

    def click_at(self, x, y):
        self.command(f'/session/{self.session}/actions', {'actions': [{
            'type': 'pointer', 'id': 'fixture-mouse', 'parameters': {'pointerType': 'mouse'},
            'actions': [{'type': 'pointerMove', 'duration': 0, 'origin': 'viewport', 'x': x, 'y': y},
                        {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}]}]})

    def test_layout_shift_records_missed_target_and_keeps_intended_identity(self):
        self.execute('''document.body.innerHTML = `
<style>body {margin:0} article {position:absolute; left:100px; top:100px; width:700px; height:700px}
button {position:absolute; left:40px; top:40px; width:120px; height:40px}</style>
<article id="sheet"><button aria-label="Preview fixture">Preview</button></article>`;
window.previewClicks = 0;
document.querySelector('button').onclick = () => previewClicks++;
''')
        element_id = self.select_preview()
        self.execute("document.querySelector('button').style.top = '247px';")
        best_effort(self.execute, CAPTURE_PREVIEW, 'before-click')
        self.click_at(200, 160)
        events = self.execute(COLLECT)['diagnostics']['events']
        checkpoints = [e for e in events if e['kind'] == 'preview.geometry']
        self.assertEqual([e['phase'] for e in checkpoints], ['selected', 'before-click'])
        self.assertTrue(all(e['pointer'] is None for e in checkpoints))
        selected, before = [e['geometry'] for e in checkpoints]
        self.assertEqual(selected['intended']['bounds']['top'], 140)
        self.assertEqual(before['intended']['bounds']['top'], 347)
        self.assertEqual(before['intended']['bounds']['pageTop'], 347)
        self.assertEqual(selected['intended']['nodeId'], before['intended']['nodeId'])
        missed = [e for e in events if e['kind'] in ('pointerdown', 'pointerup', 'click')]
        self.assertEqual([e['kind'] for e in missed], ['pointerdown', 'pointerup', 'click'])
        for event in missed:
            self.assertTrue(event['trusted'])
            self.assertEqual(event['phase'], 'dispatch')
            self.assertEqual(event['pointer']['clientX'], 200)
            self.assertEqual(event['pointer']['clientY'], 160)
            geometry = event['geometry']
            self.assertIn('ARTICLE sheet', geometry['target']['label'])
            self.assertEqual(geometry['target']['bounds']['top'], 100)
            self.assertEqual(geometry['intended']['bounds']['top'], 347)
            self.assertEqual(geometry['intended']['nodeId'], selected['intended']['nodeId'])
            self.assertTrue(geometry['intendedMatchesSelector'])
            self.assertFalse(geometry['intendedContainsTarget'])
        self.assertEqual(self.execute('return previewClicks;'), 0)
        self.command(f'/session/{self.session}/element/{element_id}/click', {})
        clicked = self.execute(COLLECT)['diagnostics']['events'][-1]
        self.assertEqual(clicked['kind'], 'click')
        self.assertTrue(clicked['geometry']['targetIsIntended'])
        self.assertEqual(self.execute('return previewClicks;'), 1)

    def test_scroll_coordinates_include_window_and_ancestor_offsets(self):
        self.execute('''document.body.innerHTML = `
<style>body {margin:0; height:2400px} #scroller {position:absolute; left:200px; top:900px;
width:400px; height:300px; overflow:scroll} #content {position:relative; width:1000px; height:1000px}
button {position:absolute; left:300px; top:250px; width:120px; height:40px}</style>
<article id="scroller"><div id="content"><button aria-label="Preview fixture">Preview</button></div></article>`;
window.scrollTo(0, 600);
document.querySelector('#scroller').scrollTo(100, 150);
window.rawPointer = null;
document.addEventListener('click', e => { rawPointer = {clientX:e.clientX, clientY:e.clientY,
pageX:e.pageX, pageY:e.pageY, screenX:e.screenX, screenY:e.screenY}; }, {once:true});
''')
        self.select_preview()
        best_effort(self.execute, CAPTURE_PREVIEW, 'before-click')
        self.click_at(460, 420)
        events = self.execute(COLLECT)['diagnostics']['events']
        self.assertEqual([e['phase'] for e in events],
                         ['selected', 'before-click', 'dispatch', 'dispatch', 'dispatch'])
        for event in events:
            geometry = event['geometry']
            self.assertEqual(geometry['window']['scrollY'], 600)
            self.assertEqual(geometry['window']['scrollX'], 0)
            bounds = geometry['intended']['bounds']
            self.assertEqual((bounds['left'], bounds['top'], bounds['pageLeft'], bounds['pageTop']),
                             (400, 400, 400, 1000))
            scroller = next(a for a in geometry['intended']['ancestors'] if 'ARTICLE scroller' in a['label'])
            self.assertEqual((scroller['scrollLeft'], scroller['scrollTop']), (100, 150))
            self.assertFalse(geometry['intended']['ancestorsTruncated'])
            self.assertEqual(geometry['viewport']['innerHeight'], self.execute('return innerHeight;'))
            self.assertEqual(geometry['viewport']['visual']['pageTop'], 600)
        clicked = events[-1]
        self.assertTrue(clicked['trusted'])
        self.assertTrue(clicked['geometry']['targetIsIntended'])
        self.assertEqual(clicked['pointer'], self.execute('return rawPointer;'))
        self.assertEqual({k: clicked['pointer'][k] for k in ('clientX', 'clientY', 'pageX', 'pageY')},
                         {'clientX': 460, 'clientY': 420, 'pageX': 460, 'pageY': 1020})

    def test_replaced_selector_match_does_not_replace_webdriver_identity(self):
        self.select_preview()
        self.execute("const old = document.querySelector('button'); old.replaceWith(old.cloneNode(true));")
        best_effort(self.execute, CAPTURE_PREVIEW, 'before-click')
        replacement = self.command(f'/session/{self.session}/element', {'using': 'css selector', 'value': 'button'})
        element_id = replacement['element-6066-11e4-a52e-4f735466cecf']
        self.command(f'/session/{self.session}/element/{element_id}/click', {})
        events = self.execute(COLLECT)['diagnostics']['events']
        selected = events[0]['geometry']['intended']
        for event in events[1:]:
            geometry = event['geometry']
            self.assertEqual(geometry['intended']['nodeId'], selected['nodeId'])
            self.assertFalse(geometry['intended']['connected'])
            self.assertFalse(geometry['intendedMatchesSelector'])
            self.assertNotEqual(geometry['selectorMatch']['nodeId'], selected['nodeId'])
        self.assertEqual(events[-1]['geometry']['target']['nodeId'],
                         events[-1]['geometry']['selectorMatch']['nodeId'])

    def test_geometry_failure_does_not_prevent_original_click(self):
        element_id = self.select_preview()
        element = {'element-6066-11e4-a52e-4f735466cecf': element_id}
        with contextlib.redirect_stderr(io.StringIO()) as log:
            best_effort(self.execute, CAPTURE_PREVIEW, 'selected', element, '[')
            best_effort(self.execute, CAPTURE_PREVIEW, 'before-click')
        self.assertIn('Could not capture smoke diagnostics', log.getvalue())
        self.execute("document.querySelector('button').onclick = () => { window.clicked = true; };")
        self.command(f'/session/{self.session}/element/{element_id}/click', {})
        self.assertTrue(self.execute('return window.clicked;'))
        events = self.execute(COLLECT)['diagnostics']['events']
        self.assertEqual(events[0]['phase'], 'selected')
        self.assertEqual([e['kind'] for e in events[1:]], ['pointerdown', 'pointerup', 'click'])
        for event in events[1:]:
            self.assertTrue(event['trusted'])
            self.assertIn('BUTTON Preview fixture', event['target'])
            self.assertIn('SyntaxError', event['geometryError'])
            self.assertIsInstance(event['pointer']['clientX'], (int, float))
            self.assertNotIn('geometry', event)

    def test_browser_collection_failure_preserves_original(self):
        self.execute("Object.defineProperty(window, '__smokeDiagnostics', {get() {throw Error('collection failure');}});")
        original = AssertionError('original no-canvas failure')
        with tempfile.TemporaryDirectory(dir=self.output) as directory, contextlib.redirect_stderr(io.StringIO()) as log:
            output = Path(directory)
            with self.assertRaises(AssertionError) as caught:
                try:
                    raise original
                except Exception as error:
                    save_artifacts(self.execute, lambda: self.command(f'/session/{self.session}/screenshot'), output, error)
                    raise
            self.assertIs(caught.exception, original)
            self.assertIn('failure-diagnostics.json', log.getvalue())
            self.assertTrue((output / 'failure.png').exists())
            self.assertIn('Preview', (output / 'failure-ui.txt').read_text())


class ArtifactFailures(unittest.TestCase):
    def test_independent_collection_and_write_failures(self):
        def execute(script):
            return {'url': 'fixture'} if script == COLLECT else 'fixture body'
        def screenshot():
            raise RuntimeError('screenshot failure')
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()) as log:
            output = Path(directory)
            (output / 'failure-diagnostics.json').mkdir()
            save_artifacts(execute, screenshot, output, AssertionError('original'))
            self.assertEqual(json.loads((output / 'failure.json').read_text()), {'error': 'original'})
            self.assertEqual((output / 'failure-ui.txt').read_text(), 'fixture body')
            self.assertIn('failure-diagnostics.json', log.getvalue())
            self.assertIn('failure.png', log.getvalue())


if __name__ == '__main__':
    unittest.main()
