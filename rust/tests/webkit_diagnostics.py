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
const nodes = new WeakMap();
let nextNode = 0;
let intended = null;
let previewSelector = null;
const bounds = node => {
  const r = node.getBoundingClientRect();
  return {left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    width: r.width, height: r.height, pageLeft: r.left + scrollX, pageTop: r.top + scrollY};
};
const describe = node => {
  if (!node || !node.getBoundingClientRect) return null;
  if (!nodes.has(node)) nodes.set(node, ++nextNode);
  const ancestors = [];
  let ancestor = node.parentElement;
  while (ancestor && ancestors.length < 32) {
    ancestors.push({label: label(ancestor), scrollLeft: ancestor.scrollLeft,
      scrollTop: ancestor.scrollTop, clientWidth: ancestor.clientWidth,
      clientHeight: ancestor.clientHeight, scrollWidth: ancestor.scrollWidth,
      scrollHeight: ancestor.scrollHeight});
    ancestor = ancestor.parentElement;
  }
  return {nodeId: nodes.get(node), label: label(node), connected: node.isConnected,
    bounds: bounds(node), ancestors, ancestorsTruncated: !!ancestor};
};
const geometry = target => {
  const match = previewSelector ? document.querySelector(previewSelector) : null;
  const v = window.visualViewport;
  return {target: describe(target), intended: describe(intended), selectorMatch: describe(match),
    selector: previewSelector, intendedMatchesSelector: !!intended && intended === match,
    targetIsIntended: !!intended && target === intended,
    intendedContainsTarget: !!intended && !!target && intended.contains(target),
    window: {scrollX, scrollY, screenX, screenY, devicePixelRatio},
    viewport: {innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      visual: v ? {offsetLeft: v.offsetLeft, offsetTop: v.offsetTop, pageLeft: v.pageLeft,
        pageTop: v.pageTop, width: v.width, height: v.height, scale: v.scale} : null}};
};
Object.defineProperty(state, 'capturePreview', {value: (phase, element, selector) => {
  if (phase === 'selected') { intended = element; previewSelector = selector; }
  record('preview.geometry', {phase, pointer: null, geometry: geometry(null)});
}});
for (const kind of ['click', 'pointerdown', 'pointerup']) {
  document.addEventListener(kind, e => {
    const data = {target: label(e.target), trusted: e.isTrusted, button: e.button,
      phase: 'dispatch', pointer: {clientX: e.clientX, clientY: e.clientY,
        pageX: e.pageX, pageY: e.pageY, screenX: e.screenX, screenY: e.screenY}};
    try { data.geometry = geometry(e.target); }
    catch (error) { data.geometryError = text(error); }
    record(kind, data);
  }, true);
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

CAPTURE_PREVIEW = r"""
window.__smokeDiagnostics.capturePreview(...arguments);
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


def best_effort(execute, script, *args):
    try:
        execute(script, *args)
    except Exception as error:
        print(f'Could not capture smoke diagnostics: {error}', file=sys.stderr, flush=True)


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
