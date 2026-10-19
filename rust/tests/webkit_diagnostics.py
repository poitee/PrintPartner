import base64
import json
import sys


INSTALL = r"""
'use strict';
if (window.__smokeDiagnostics) return;
const state = window.__smokeDiagnostics = {events: [], dropped: 0};
const text = value => {
  try { return String(value).slice(0, 500); } catch (_) { return '<unprintable>'; }
};
const label = node => node && node.tagName ? text([
  node.tagName, node.id, node.getAttribute('role'), node.getAttribute('aria-label'),
  node.textContent?.slice(0, 160)
].filter(Boolean).join(' ')) : text(node);
const record = (kind, data) => {
  if (state.events.length === 80) { state.events.shift(); state.dropped++; }
  state.events.push({kind, ms: performance.now(), ...data});
};
for (const level of ['warn', 'error']) {
  const original = console[level];
  console[level] = function(...args) {
    try { record('console.' + level, {args: args.slice(0, 8).map(text)}); } catch (_) {}
    return Reflect.apply(original, this, args);
  };
}
addEventListener('error', e => record('window.error', {
  message: text(e.message), filename: text(e.filename), line: e.lineno, column: e.colno
}));
addEventListener('unhandledrejection', e => record('unhandledrejection', {reason: text(e.reason)}));
for (const kind of ['click', 'pointerdown', 'pointerup']) {
  document.addEventListener(kind, e => record(kind, {
    target: label(e.target), trusted: e.isTrusted, button: e.button
  }), true);
}
const canvases = new WeakMap();
let nextCanvas = 0;
const canvasId = canvas => {
  if (!canvases.has(canvas)) canvases.set(canvas, ++nextCanvas);
  return canvases.get(canvas);
};
for (const kind of ['webglcontextlost', 'webglcontextrestored', 'webglcontextcreationerror']) {
  document.addEventListener(kind, e => record(kind, {
    canvas: canvasId(e.target), target: label(e.target), status: text(e.statusMessage)
  }), true);
}
const original = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(...args) {
  const gl = Reflect.apply(original, this, args);
  try {
    if (['webgl', 'webgl2', 'experimental-webgl'].includes(args[0])) {
      const data = {canvas: canvasId(this), type: args[0], target: label(this),
        width: this.width, height: this.height, available: !!gl};
      if (gl) {
        try {
          data.lost = gl.isContextLost();
          data.version = text(gl.getParameter(gl.VERSION));
          data.vendor = text(gl.getParameter(gl.VENDOR));
          data.renderer = text(gl.getParameter(gl.RENDERER));
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          if (debug) data.unmaskedRenderer = text(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
        } catch (error) { data.metadataError = text(error); }
      }
      record('getContext', data);
    }
  } catch (_) {}
  return gl;
};
"""

COLLECT = r"""
const active = document.activeElement;
return {
  url: location.href, readyState: document.readyState, focused: document.hasFocus(),
  activeElement: active ? [active.tagName, active.id, active.getAttribute('aria-label')].filter(Boolean).join(' ').slice(0, 500) : null,
  dialogs: document.querySelectorAll('[role=dialog], dialog').length,
  canvases: document.querySelectorAll('canvas').length,
  dialogCanvases: document.querySelectorAll('[role=dialog] canvas, dialog canvas').length,
  mesh: window.__smokeMesh || null,
  diagnostics: window.__smokeDiagnostics || null
};
"""


def save_artifacts(execute, screenshot, output, error=None):
    """Attempt every artifact independently; never replace the smoke's exception."""
    outcome = 'success' if error is None else 'failure'
    attempts = [(f'{outcome}-diagnostics.json', lambda: json.dumps(
        {'outcome': outcome, 'error': None if error is None else str(error),
         **execute(COLLECT)}, indent=2).encode() + b'\n')]
    if error is not None:
        attempts += [
            ('failure.json', lambda: json.dumps({'error': str(error)}, indent=2).encode() + b'\n'),
            ('failure.png', lambda: base64.b64decode(screenshot())),
            ('failure-ui.txt', lambda: execute('return document.body.innerText;').encode()),
        ]
    for name, collect in attempts:
        try:
            (output / name).write_bytes(collect())
        except Exception as artifact_error:
            print(f'Could not save {name}: {artifact_error}', file=sys.stderr, flush=True)
