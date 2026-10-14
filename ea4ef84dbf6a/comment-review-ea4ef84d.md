# Comment Sicko

Scope: newly added or modified source comments and lint suppressions in `git diff origin/main...HEAD` at `/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610141227-9efa`.

Exact head: `ea4ef84dbf6a92c08ffb0d96bf2fc1a09f5f0ac4` (`Merge main into GRE-353 account mapping`).

Merge-base: `a1be5ab0d53d746ae4a1e8746c3e6817d857d8a3` (`origin/main`).

Parents: `8e39f7a72d6faeb203603b59565b81d86ef70689` (mapped auth and upload shutdown correction) and `a1be5ab0d53d746ae4a1e8746c3e6817d857d8a3`.

Prior original no-comment reviews were clean: `comment-review.md` at `0f429d3a8484ef3a98243d7ced56fd0a54664842`, and `comment-review-final.md` at `99517b342adfdc4c635c069642dc4e07058fc3d6`. This pass re-read the full three-dot diff at this head. Read-only. No Comment Sicko child. No source edits, commits, pushes, scores, or builds.

GitHub PR 375 still records head `99517b342adfdc4c635c069642dc4e07058fc3d6`. This report is the local exact head above.

Working tree clean against that head.

No criteria score. CI was not read.

## Touched files

None. No added, removed, or modified source comment or lint suppression.

Correction and merge files inspected, all comment-free in the three-dot diff:

- `web/apps/server/src/routes/auth.ts` (mapped account routes return after read-only `/auth/me`)
- `web/apps/server/src/routes/health.ts` (mapped capability calculation)
- `web/apps/server/src/services/printer-send-queue.ts` (optional tenant scope on the existing shutdown operation)
- `web/apps/server/src/desktop.ts` (mapped stop passes that scope)
- `web/apps/server/src/routes/auth-security.test.ts`
- `web/apps/server/src/services/printer-upload-shutdown.test.ts`
- `rust/crates/pp-core/tests/runtime_m0/ticket_t_68_desktop_account_mapping.rs`
- `rust/crates/pp-core/src/lib.rs` (`DesktopAccountPin::capture` after the lease acquire)

`start_resources` at this head still calls `pp_storage::lease::prepare_directory` before `StorageLease::acquire` and before `DesktopAccountPin::capture`. That admission line is main's. The merge adds no comment around it.

## Deletion count

0

## Findings

None.

## MUST KILL

None.

## Skips

None. No added or modified comment or suppression met a keep clause, because none were in the diff.

Not comments, so not judged:

- `docs/desktop-rebuild.md` adds the section "Map one existing account". That is product documentation, not a source comment. The merge's "D5 retained capture" prose matches `origin/main` and is outside this diff.
- Rust `#[cfg]`, `#[cfg(feature = "desktop_rebuild")]`, `#[cfg(not(feature = "desktop_rebuild"))]`, `#[cfg(target_os = "linux")]`, `#[cfg(test)]`, `#[test]`, `#[tokio::test]`, `#[path]`, and `#[derive]` attributes are code, not comments or lint suppressions. `cfg!(feature = "desktop_rebuild")` in `DesktopAccountPin::capture` and `apply` is a macro invocation. Thirty-nine added attribute lines.
- `//` inside string literals (`http://`, `https://`, `file://`) is URL syntax. Added occurrences are three `file://` database URLs and one `https://example.test` fixture URL in `ticket_t_68_desktop_account_mapping.rs`, plus two `http://desktop` bases in `app.ts`.
- `.expect(...)` in the mapping test is `Result::expect`. `expect(...)` in the Node tests is the assertion API. Neither is `#[expect]` or a lint suppression.
- `unsafe { libc::geteuid() }` in `account_pin.rs` and `unsafe { libc::kill(...) }` in `ticket_t_68_desktop_account_mapping.rs` have no safety comment and no suppression. Test names `unsafe_files_fail_without_blocking` and `rejects an unsafe %s mapping` are identifiers.
- Comments that arrived with main, including the health-request IPC notes and the supervisor completion notes, match `origin/main`. Unchanged context comments in `app.ts` and `db/client.ts` were not edited.

Scanned 1395 added source lines across the 21 Rust, TypeScript, and Cargo files in the three-dot diff (939 Rust, 451 TypeScript, 5 Cargo) and 42 added documentation lines. Fifty-eight removed source lines. Zero `//`, `/* */`, `///`, `//!`, `#` comments, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `prettier-ignore`, `#[allow]`, `#[expect]`, or `clippy::` suppressions were added or removed. Cargo.toml feature lines contain no `#` comments.
