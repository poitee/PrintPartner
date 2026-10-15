# PR #470 GRE-498 Plan feature override controls: Claude Opus 5.5 other-engine score

Verdict: PASS. Score 9/10.
Head: 7cd010c0a4e18d7f7d386406ca3ed48f1e9fff68. Local HEAD and GitHub headRefOid match. The PR is OPEN and MERGEABLE against main.
Base: 09a13c1a. The diff has 15 files and +854/-1 lines. It has no server production or Rust changes. The server change is one added test only.

## Blockers
None.

## Criteria
- Default-off, rebuild-gated. `PlanFeaturesCard.tsx:58-69` returns null and disables the query unless health advertises `tenant_feature_toggles` and the engine is ready. Two tests prove zero reads with the flag off: the card capability-off test and `PartsPage.features.test.tsx:111`. The flag-off.png screenshot also shows no card.
- Farm, orders, Bambu, and Spoolman each get Inherit, On, and Off. The card maps these to true, false, and null through `choiceToOverridePatch`. Both directions parse through the shared Zod schemas in `planFeatures.ts`.
- Inheritance. Clearing an override sends null, and the server reports source "user". A tenant PATCH invalidates `["planFeatures"]` (`tenantFeatures.ts:25`), so inherited values refresh.
- Persistence. `plan-features.test.ts:125` closes and reopens SQLite. It checks all four overrides, sibling isolation, /api/v1, null clearing, and live tenant inheritance after the clear. The mutant log shows this test fails when the stored value becomes `{}`.
- Pending, empty, and accepted states. The card renders once, keyed by `selectedProfileId` (`PartsPage.tsx:94-96`). The before-page log shows 2 of 3 tests failing; after the change, 3 of 3 pass.
- Save behavior. No save is optimistic, and success writes the cache under `response.profile_id`. Controls are disabled while a save is pending or the engine is offline. The in-flight Plan-switch test confirms the Plan 1 response does not leak into the Plan 2 cache.

## Non-blocking nits
- Clicking the already-active segment still sends a redundant PATCH. This is harmless and idempotent.
- The in-flight switch test rerenders without `key`, while production remounts via `key`. The test still proves cache isolation. It does not exercise the keyed remount path.
- In the shared SegmentedControl, the active segment has low contrast in dark mode. This predates this PR.

## Visual
default-off-features.png shows four rows on Inherit, each "Effective: Off · Default". all-enabled.png shows four rows On with source "Plan override". inheritance.png shows farm on Inherit, effective On from "Account setting", while the others are On from "Plan override". flag-off.png shows no card, and the rest of the Plan page is intact. Layout and labels are clear.

## Commands run (independent)
- `git rev-parse HEAD`, `gh pr view 470 --json headRefOid,state,mergeable`: 7cd010c0…, OPEN, MERGEABLE
- `gh pr checks 470`: 18 pass, 5 skipping, 0 fail or pending
- `npm run test -w @print-partner/server -- src/routes/plan-features.test.ts src/routes/tenant-features.test.ts --maxWorkers=2`: 2 files, 88/88 passed
- `npm run test -w @print-partner/web -- PlanFeaturesCard, PartsPage.features, initialization, recovery, TenantFeaturesSettingsCard, SettingsPage.features`: 6 files, 36/36 passed

## Evidence limits
- I did not rerun the persistence mutant or the original-page baseline, because this review is read-only. Those results come from the recorded logs.
- I did not drive the browser myself. Visual judgment rests on the provided screenshots and browser-proof.json.
- Local Node is 24. CI runs on Node 22 and is green.
