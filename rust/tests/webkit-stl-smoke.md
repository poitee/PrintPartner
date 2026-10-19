# WebKit STL smoke diagnostics

`webkit_stl_smoke.py` installs `webkit_diagnostics.py` after Plan navigation and
before preview interaction. It wraps the page's own `getContext` calls and
records context availability, dimensions, version, vendor, renderer, and optional
unmasked renderer. It records context loss, restoration, and creation errors.
It never creates a diagnostic context or reads `getError`.

The shared event buffer retains the latest 80 entries and reports how many it
dropped. Console arguments have a limit of eight per entry and 500 characters
per argument. The wrappers forward the original arguments, receiver, return
value, and exceptions. Window errors, unhandled rejections, and capture-phase
click and pointer targets use the same buffer.

Preview geometry uses that buffer at three points. `preview.geometry` entries
have phase `selected` immediately after the WebDriver element lookup and
`before-click` immediately before the original element click command. The
capture-phase `pointerdown`, `pointerup`, and `click` entries have phase
`dispatch`. Only dispatch entries have event coordinates. Checkpoint `pointer`
values are null because no pointer event exists at those points.

Each geometry entry includes the following fields.

- `intended` describes the DOM element resolved from the original WebDriver
  element reference. A closure retains it across checkpoints and dispatch.
- `selectorMatch` describes the current selector result. `nodeId`, `connected`,
  and `intendedMatchesSelector` distinguish layout movement from replacement.
  Node IDs are local to the installed diagnostics, not WebDriver element IDs.
- `target` describes the actual event target at dispatch, including events that
  miss the preview button. It is null for checkpoints. `targetIsIntended` and
  `intendedContainsTarget` also identify clicks on button descendants.
- Each element has client bounds from `getBoundingClientRect`, plus `pageLeft`
  and `pageTop` computed by adding window scroll offsets. Ancestor scrolling is
  already reflected in client bounds. Do not add it again to page coordinates.
- `ancestors` records scroll offsets and client and scroll dimensions for up to
  32 parents per element. `ancestorsTruncated` marks deeper chains.
- `window` records scroll offsets, screen position, and device pixel ratio.
  `viewport` records inner and document client dimensions and visual viewport
  offsets, page position, dimensions, and scale when available.
- Dispatch `pointer` records the event's `clientX`, `clientY`, `pageX`, `pageY`,
  `screenX`, and `screenY` without conversion.

Installation and checkpoints catch diagnostic failures and report them to
stderr. Dispatch capture catches its own failures. These diagnostics do not
scroll, retry, replace the clicked element, or change smoke deadlines or pass
criteria. Geometry reads and the two extra WebDriver script commands can affect
timing. They cannot observe layout changes inside WebDriver between the last
checkpoint and event dispatch.

`success-diagnostics.json` or `failure-diagnostics.json` includes the URL, focus,
active element, dialog and canvas counts, mesh observation, and event buffer.
Failure JSON, diagnostics, screenshot, and UI text each get an independent
best-effort attempt. Artifact errors go to stderr without replacing the smoke
failure. Canvas and pixel pass criteria remain in `webkit_stl_smoke.py`.

CI runs the focused tests immediately after distro dependencies install.
`diagnostics-tests.log` records their counts. `runner-glxinfo.txt` describes a
separate runner GLX probe. The viewer's `getContext` entries are the evidence
for its actual renderer. Driver stderr goes to `verify.log` through `2>&1 | tee`.
`desktop-driver.log` retains driver stdout.

Run the disposable fixture checks from the repository root. On shared hosts,
acquire the host build slot first.

```sh
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24' \
  env LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  python3 rust/tests/test_webkit_diagnostics.py -v
```

The seven MiniBrowser tests use temporary profiles and a loopback fixture.
They reproduce the no-canvas timeout after a short-lived real context, exercise
forwarding and buffer bounds, lose a real context, request an incompatible null
context, and break collection while preserving the original failure. Geometry
fixtures move a button by 207 pixels and send trusted pointer actions to its old
position, record a later successful element click, distinguish a replacement
selector match, and combine window scrolling with an overflow ancestor. Another
fixture breaks geometry capture while the original element click still runs.
The creation-error event is synthetic. One Python-only test covers independent
artifact failures. These checks validate evidence capture. They do not establish
the cause of GRE-709 or verify native mesh rendering.
