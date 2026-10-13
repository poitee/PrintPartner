# GRE-408 final verification round

Head 8f06f75a9ad2fbc433d3c3244f50b92a2b70871f. Adds one 93-line test inside jobs.rs cfg(test). No production logic changes after the integrated b4fb2cab restart correction.

The same in-memory SQLite connection uses max_page_count equal to its existing page_count. A bounded loop calls the durable enqueue domain operation in immediate transactions until SQLite returns ErrorCode::DiskFull. The failed transaction leaves exactly the prior successful count in jobs, idempotency keys and history, with no key for the failed request. After restoring the page budget, retrying that same key adds one job and duplicate replay returns the same id read-only, without another job/key/history.

Focused exact test: 1 passed. Required workspace claims command: 16 passed, 248 skipped. Fmt, Clippy with warnings denied and diff checks pass. No full storage or Core rerun was needed for this tests-only addition; b4fb2cab receipts remain 155/155 storage and 9/9 Core, with unchanged production code. No public WriterOwner disk quota/admission or CommitUnknown fault path is claimed by this component test.

The first short-name --exact invocation selected zero tests. It is excluded from accepted evidence. sqlite-full-exact.log and claims.log have the required nonzero counts. A permitted local Strix GLM helper inspected APIs but made no edits; it was stopped before the parent implemented the test.

Round 2 Grok Build scored the restart correction 9/10 and full GRE-408 readiness 6/10, at https://github.com/poitee/PrintPartner/pull/134#issuecomment-6148466353. This addition addresses the missing dedicated SQLite-full proof, but all 28 job aliases remain compat-owned and production durable worker/client cutover remains absent. Full issue readiness must be scored honestly in final round 3, and Linear must not be marked ready based solely on the narrow restart score.

Evidence corrections are append-only in decisions.tsv. The earlier crash row's invalid archived pointer was superseded by the canonical crash-red-reproduced.log. Initial merged Core failures were four direct release-artifact mismatches and two downstream readiness/concurrent-owner assertions; the same nine cases passed after refreshing the manifest. Updated round2 README uses this precise wording.

Final Grok Build review at issuecomment-6149026938 independently replayed the exact SQLite-full unit and crash regression, one passed each. Scoped score 9/10; full GRE408 score 6/10. Original mandatory joint route/worker cutover remains absent. After three review tasks, stopping as requested, retaining Linear In Progress and handing back with CI still pending. Final PR readback is mergeable, no conflicts, 13 passed checks, five pending, zero failures. No PR merge, auto-merge or force push.
