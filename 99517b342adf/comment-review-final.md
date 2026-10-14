# Comment Sicko

Scope: newly added or modified source comments and lint suppressions in `git diff origin/main...HEAD` at `/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610141227-9efa`.

Exact head: `99517b342adfdc4c635c069642dc4e07058fc3d6` (`fix(compat): stabilize account pin API across features`).

Merge-base: `f73756f7d2b8b6aa1fbcb4950c040f96ede5b746`.

Parent of head: `0f429d3a8484ef3a98243d7ced56fd0a54664842`. Prior review `comment-review.md` found no comments or suppressions at that parent. This pass re-read the full three-dot diff and the correction `git diff 0f429d3a8484ef3a98243d7ced56fd0a54664842..99517b342adfdc4c635c069642dc4e07058fc3d6`.

Working tree clean against that head. No source edits, commits, pushes, children, scores, builds, or staging changes.

## Touched files

None. No added, removed, or modified source comment or lint suppression.

Correction files inspected, all comment-free:

- `rust/crates/pp-compat/src/account_pin.rs` (+35 / context of the pin gate)
- `rust/crates/pp-compat/src/lib.rs`
- `rust/crates/pp-compat/src/ticket_t_2.rs`
- `rust/crates/pp-compat/tests/installed_bundle_lifecycle.rs`
- `rust/crates/pp-core/src/lib.rs`

The correction is +35 / −21 lines. Every removed line is a `#[cfg(feature = "desktop_rebuild")]` attribute or the cfg-wrapped setup block it guarded. Those are code, not comments.

## Deletion count

0

## Findings

None.

## MUST KILL

None.

## Skips

None. No added or modified comment or suppression met a keep clause, because none were in the diff.

Not comments, so not judged:

- `docs/desktop-rebuild.md` adds the section "Map one existing account". That is product documentation, not a source comment.
- Rust `#[cfg]`, `#[cfg(not(feature = "desktop_rebuild"))]`, `#[cfg(test)]`, `#[test]`, `#[tokio::test]`, `#[path]`, and `#[derive]` attributes are code, not comments or lint suppressions. The correction adds and removes `#[cfg(feature = "desktop_rebuild")]` on the pin module, `SpawnSpec.account_pin`, callers, and pin tests. `cfg!(feature = "desktop_rebuild")` in `DesktopAccountPin::capture` and `apply` is a macro invocation.
- `//` inside string literals (`http://`, `https://`, `file://`) is URL syntax. Added occurrences are `file://` database URLs in `ticket_t_68_desktop_account_mapping.rs`, one `https://example.test` fixture URL there, and `http://desktop` in `app.ts`.
- `unsafe { libc::geteuid() }` in `account_pin.rs` and `unsafe { libc::kill(...) }` in `ticket_t_68_desktop_account_mapping.rs` have no safety comment and no suppression. Test names `unsafe_files_fail_without_blocking` and `rejects an unsafe %s mapping` are identifiers.

Scanned 1275 added source lines across the 16 Rust, TypeScript, and Cargo files in the three-dot diff (42 added documentation lines excluded). Zero `//`, `/* */`, `///`, `//!`, `#` comments, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `prettier-ignore`, `#[allow]`, `#[expect]`, or `clippy::` suppressions were added or removed. Cargo.toml feature lines contain no `#` comments.
