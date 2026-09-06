# Plan autosave

Ordinary file and quantity edits use one `POST /plans/:id/save` request. The browser sends stable file identities, final choices, the accepted Plan base, and the exact open draft it observed, or null. It keeps newer local choices visible while the request runs.

The server owns the complete save. It prepares a command-owned draft with the final choices, reconciles Required units once, and publishes through the existing native `applyPlanChanges` operation. It does not update accepted revisions in place. The SQLite transaction rolls back draft creation, reconciliation, publication and lifecycle changes together on failure.

A retry sends the same original command and idempotency key. The server checks the durable receipt before testing the current Plan base. A reused key with a different payload fails. Existing draft work is copied rather than abandoned before success; only the explicitly selected original draft closes after publication succeeds.

The response contains the commit receipt, a full authoritative Review, the profile summary, and closed draft IDs. The server captures the Review snapshot and profile summary together before asynchronous filament enrichment. A receipt may refer to an earlier commit on replay, but the returned Review must not predate that receipt.

The browser hydrates both Review variants from this result, retains newer local intent, and rejects older responses. It invalidates other screens without fetching every screen before reporting Saved. Source recovery and explicit draft operations retain their existing APIs and safety rules.

## Design decision

Two designs were compared: composing the native draft/publication operations, and directly applying accepted-plan deltas. Native composition is the base because it retains the existing history, completion, production and Checkoff protections. The delta design contributed applying choices in memory before the first draft insertion and capturing one consistent read snapshot.

Direct accepted-row mutation was rejected because it bypasses immutable revision and Required-unit ownership rules. Blindly chaining the old endpoints was rejected because it reconciles twice and ordinary recompute abandons open drafts. The independent design check agreed with native composition plus final-state insertion and consistent response capture.

## Verification

Real SQLite tests cover atomic rollback, existing draft preservation, progress, source changes, committed retries, changed payloads and stale bases. Route tests require one reconciliation and confirmed state. Client tests delay responses and exercise rapid choices, retry identity, cache hydration and Build navigation.

Latency is measured from the click to confirmed Saved, separately from immediate checkbox feedback. The target is at least 95 percent of repeated single-file and folder saves below two seconds, without reversals or lost persistence. Local tests and live-host measurements are reported separately; a passing local benchmark is not proof of deployed latency.

Run the repeatable server benchmark from `web/`:

```sh
node --conditions=development --import tsx scripts/plan-save-benchmark.mts
```

It creates an isolated temporary database with 350 initially selected files across seven tracked sources, compares 30 single-file and 30 ten-file saves per path, checks returned choices, and fails if the new path's 95th percentile exceeds two seconds. Add `--serve` to start that fixture on loopback port 5182 for browser testing. It does not use the production database.

The September 6 local run measured new-path p95 server times of 385 ms for single files and 279 ms for ten-file batches, compared with 660 ms and 485 ms for the old sequence. These are local server timings, not network or browser timings.

An isolated development-browser pass observed 19 of 20 single-file/folder saves below 0.9 seconds; one single-file sample took 3.45 seconds. Timings include browser-control and polling overhead. No checkbox reversals or error alerts occurred, and three quick reversals retained the final selection. Live-host latency still needs measurement after deployment.
