# GRE-353 remote-frame acceptance evidence

Source head 69d25650e183316318ac9531007614902b865dff. The committed verifier is rust/tests/webkit_stl_smoke.py. This receipt covers unsigned Linux WebKitGTK. It does not certify macOS, signed distribution, final native teardown, native actions, or tenant owner mapping. GRE-353 remains In Progress.

The exact-head pipeline builds the production desktop frontend with VITE_PRINT_PARTNER_DESKTOP=1, stages current server/frontend and Node, embeds the full-SHA bundle manifest in pp-desktop, and runs the native verifier under DBus/Xvfb with Mesa software rendering. exact-head-proof.json binds verifier, binary and manifest hashes to the receipt. See exact-head-proof.py for commands. Run its pipeline through the landing slot locally; CI runs the committed verifier directly in the existing desktop-webkit workflow.

Positive and negative MiniBrowser controls use the same resolved WebKitGTK shared library as native. Both must record actual child document GET, script-only beacon and authenticated child postMessage. The unchanged denial predicate must reject the negative exactly as target_executed. Strict MiniBrowser and native must record a trusted enforcing frame-src event matching the full gateway policy and target/document origins, no child execution/GET, original document/root/token/href preserved, and at least three seconds after the matching event.

MiniBrowser controls test engine CSP enforcement. They do not prove Wry admits remote iframe navigation without CSP. Frame fixture and control cleanup is recorded after cleanup. The existing overall native receipt precedes final native teardown and makes no teardown claim.

predicate-audit.py reruns 24 denial mutations against real recorded observations. Every mutation must fail with its named reason; harmless policy whitespace and document fragments remain accepted.

Preparation failures are retained in decisions.tsv. Generic frontend build lacked the desktop marker and staging failed closed. Only the subsequent desktop build and verified-stage pipeline are final evidence. Earlier prototypes and working-tree runs were feasibility and implementation checks.
