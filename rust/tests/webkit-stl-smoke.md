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

The three MiniBrowser tests use temporary profiles and a loopback fixture.
They reproduce the no-canvas timeout after a short-lived real context, exercise
forwarding and bounds, lose a real context, request an incompatible null context,
and break collection while preserving the original failure. The creation-error
event is synthetic. One Python-only test covers independent artifact failures.
These checks validate evidence capture, not the cause of GRE-709 or native mesh rendering.
