---
name: pp-readiness
description: Assess Print Partner Missions readiness and choose existing QA checks for a Rust migration slice. Use for readiness reviews, bounded verification, or preparing a migration Mission.
---

# Print Partner readiness

This skill reuses repository verification tools. It does not install a QA platform, plugins, CI workflows, or services.

## 1. Establish scope

Read the root [agent guide](../../../AGENTS.md), [readiness gates](../../../docs/development/missions-readiness.md), and [QA runbook](../../../docs/development/mission-qa.md).

Record the checkout, branch, exact HEAD, dirty files, relevant issue, and requested outcome. Preserve user changes. Do not turn a read-only assessment into implementation or launch a Mission without authorization.

Separate today's mixed Node/Rust applications from the Rust target. For architecture or scope changes, consult the linked current Linear/Notion sources. If access is blocked, say so; do not silently use superseded design text.

## 2. Select evidence

Map changed paths to the runbook's checks. State the test selector, time budget, required dependencies/OS/display, runtime owner, feature mode, and expected assertions before expensive runs.

- Use `scripts/local-ci.py --list`, the CI guide, and package scripts instead of maintaining another CI check list.
- For Rust ownership changes, cover flag-off and flag-on behavior where applicable, aliases/workers, persistence, and restart/error recovery. Compile-only proof is insufficient.
- For gateway/web QA, use the existing isolated harnesses. Never use real printer sends or user data for a smoke test.
- For native desktop/slicer paths, require the actual runtime and platform receipts. A browser fallback may explain a readiness criterion but does not satisfy native acceptance.
- A named test must execute a nonzero count. Collection-only and historical receipts must be labeled. Report SKIPs and timeouts even if the wrapper exits zero.

## 3. Verify and clean up

Run only checks justified by the requested scope. Use private temporary credentials, fresh fixtures, and loopback listeners. Keep commands and non-secret evidence. Stop owned processes through harness cleanup or SIGTERM in a `finally`/trap path; retain only the evidence needed for the report.

Do not install missing system tools, expose listeners, change product defaults, or alter external records merely to complete an assessment. Report the blocker and the required follow-up.

## 4. Report without promoting targets to passes

Use this structure:

1. **Snapshot:** commit, branch, dirty state, evaluated application paths.
2. **Scope:** requested work, affected operation/runtime, flag modes.
3. **Evidence:** command, tool/OS versions, assertion or executed count, duration, exit status, artifact path.
4. **Not proven:** skips, timeouts, collection-only results, native/remote-only gates.
5. **Migration gates:** current implementation versus target acceptance, with existing issue/source links.
6. **Next action:** one bounded slice and its acceptance criteria, plus maintainer/display decisions needed.

Leave the saved readiness report unchanged unless the user requests a fresh complete evaluation. Do not claim independent review from self-review or create duplicate follow-up tickets.
