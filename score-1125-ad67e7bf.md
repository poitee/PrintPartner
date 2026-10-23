Score: 7

I scored this by reading the code only. My attempts to run the focused vitest files and `tsc --noEmit` needed approval and didn't run, so I have no local test or typecheck evidence for this SHA. The direction is right: the flush registry now keeps a separate registration per producer and returns its own cleanup, `flushAll` waits for every producer with `allSettled`, the failed payload is retained, and the tests have readable names. The only renderer of `PlanSpecialRequestField` is `BuildPage`, which sits under `BuildSaveFlushProvider` in `AuthenticatedApp.tsx:55`, so the new hook is safe. Three correctness gaps keep it at 8 or below.

**Blockers**
1. **The manifest retry bypasses the in-flight queue** (`useKitManifestAutosave.ts`, the `retainFailedAuxiliarySave(... persistKit(kit, true))` closure). `retryPlanSave` calls `savePlanKitManifest` directly, without setting or awaiting `saveState.inFlight`. If an autosave is running at the same time, two PUTs race. An older retained kit can then land after a newer one and overwrite `baseKit` and `savedSelections`. The retry should go through `saveSelections`/`flushSave`, or at least chain on `inFlight`.
2. **A retained kit is dropped silently when selections match the saved ones.** `drainQueuedSelections` works out `needsSave` only from `selectionsToSave` and `savedSelections`. If `retainedFailedKit` is set but `pendingSelections` has gone back to equal `savedSelections` (for example after a prop resync), the loop hits `continue`. The kit is never sent and `retainedFailedKit` is never cleared. `flushSave` then succeeds while the hook still reports a failure intent. `needsSave` should also be true when a retained kit exists. That also makes the new `!retainedFailedKit` guards in `saveSelections`/`flushSave` actually do what they intend.
3. **The special-request flush doesn't wait for a save in progress.** `flushSpecialRequestSave` returns `Promise.resolve()` when the draft is `"saving"`, so the navigation barrier can let the user leave while that request is still unresolved. The new `BuildSaveFlushContext` test says the barrier "waits for every producer", which isn't true for this producer. The in-flight promise should be tracked per profile and awaited.

**Non-blocking (one batched follow-up ticket)**
- **New navigation behavior:** registering the special-request flush means navigating off Build now saves an unblurred draft, and a failed save blocks navigation. That's probably intended, but neither the D29 doc nor a test says so.
- **Dead code:** `hasFailedAuxiliarySave` is exported but never used.
- **Duplicated save block:** the save-success code in `drainQueuedSelections` duplicates `persistKit(kit, true)`. Calling `persistKit` there would remove the copy.
- **Partial retries:** `retryFailedAuxiliarySaves` stops at the first failure, so the manifest isn't retried when the special-request retry fails. That's acceptable, but it should be documented.
- **Weak test:** `failed_special_request_retry_preserves_order` passes no matter which order the two kinds are retained in. Retaining the manifest first and checking that it still runs first would actually prove "first-failure order".

Fixing 1–3, with a red-then-green test for #2 and for the in-flight race, plus real evidence from the focused tests and typecheck, would put this above 8.
