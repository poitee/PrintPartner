# PR #132 — local body additions

Prepared locally for the coordinator. Append the sections below to the existing
PR body only after the chain lands and pushing is explicitly authorized. No code,
evidence branch, PR body, review reply, or thread resolution was published.

## Evidence at new head

Exemption: none.

Model/harness: Codex gpt-6.1-sol xhigh, T3 VM 135

The tested source includes the local merge of main and the reset-capacity fix.
The final local head used for fresh captures is recorded in
`/persist/home/evidence/pr132-vm135-20261011/head.txt`; each live JSON receipt
also records its full head SHA. Substitute that exact SHA and the eventual
published artifact links into this draft when updating the PR body.

Local evidence root: `/persist/home/evidence/pr132-vm135-20261011/`.

### Integration and review

- Starting head: `3db79a4713e7817b9d991366d8d7c13f4244d631`.
- Fetched origin; no other local #132/auth-http branches or worktrees with
  unpushed commits were found. The current worktree started clean.
- Parent `origin/desktop/source-media-integration` at
  `6c037fcb459bb0dd42aab463aaebf2c83febaa12` was already included.
- Merged `origin/main` at `b497e887651e10d26c0cdd4a0f0b26130f5ac7d1` through
  merge commit `d6c416173c27c4f2859a31a5bc48b2bb230e2f02`.
- Resolved six files: `rust/Cargo.toml`, `rust/Cargo.lock`,
  `rust/crates/pp-core/src/lib.rs`,
  `rust/crates/pp-compat/tests/installed_bundle_lifecycle.rs`,
  `rust/crates/pp-source/src/lib.rs`, and `rust/scripts/check-boundaries.py`.
  Auth/storage support, real child ownership recording, main's supervisor
  configuration, the new crate boundaries, and canonical path collision checks
  are retained together. Locked dependencies include both sets of workspace
  crates; main's exact dependency pins and action SHAs are preserved.
- The first full workspace run found three source snapshot integration failures:
  raw directory aliases were rejected before main's canonicalization. Snapshot
  validation now uses the same sorted canonical directory spellings as
  publication while keeping original input paths. Archive/media validation and
  full Unicode collision checks remain intact. Existing ASCII/accented shared
  folder, omission overlap, and retry regressions cover this resolution.
- Read the complete open review threads through `gh api graphql`, plus the
  Greptile/Bugbot reviews through `gh api`. No chad label is present on #132.
- Fixed Greptile P1 [reset requests reveal accounts](https://github.com/poitee/PrintPartner/pull/132#discussion_r4239420544):
  each accepted reset request reserves one of 16 slots for a fixed 15-second
  window, including unknown addresses and early SMTP completion or failure.
  Delivery shares that deadline, and HTTP replies do not wait for it. Releasing
  delivery capacity therefore cannot expose account existence.
- Expanded the bound HTTP/SMTP regression across successful, rejected, dropped,
  and blocked SMTP. It fills capacity using unknown addresses and checks equal
  known/unknown response bytes and overload status within the 20-request limit.
  The original handler fails this regression (`200` instead of `503`);
  the corrected handler passes. See `p1-before.log` and `p1-regression.log`.
- The separate P2 [shutdown drops reset emails](https://github.com/poitee/PrintPartner/pull/132#discussion_r4239420546)
  remains open and is outside the requested P0/P1 fixes. Delivery tasks are
  still detached. No remote review threads were resolved during local prep.

### Required local checks

```sh
scripts/check-github-actions-pinned.sh
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --locked --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --locked --manifest-path rust/Cargo.toml --workspace
```

Final result: **159 passed, 0 failed, 0 ignored** across the locked
workspace, including 21 API tests, 37 source tests, and 23 real core runtime
tests. Formatting, strict workspace/all-target Clippy, and action pin checks
passed (`checked=48 exempt_local=2 unpinned=0`).

The desktop runtime tests require the real locked web build and measured
manifest, prepared first with:

```sh
npm ci --prefix web
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/build-desktop-manifest.py --web web \
  --node /opt/agent-fleet/bin/node --output rust/bundle-manifest.json \
  --commit "$(git rev-parse HEAD)"
```

Also ran the crate boundary and domain dependency self-tests and
`git diff --check`. Logs are in the local evidence root; final workspace test
counts are recorded in `test-counts.json`.

### Fresh live reset proof

Build `auth-http-fixture` from the final prepared local head, then run:

```sh
python3 /persist/home/evidence/pr132-vm135-20261011/reset-capacity-proof.py
```

This drives the actual bound Rust auth HTTP surface and SQLite writer with
disposable accounts and data. It sends 16 requests for a known or unknown
candidate, probes both addresses from the original and a fresh loopback peer,
then probes after the delivery window expires. The SMTP boundary locally
rejects transport or stalls the TLS handshake; it does not replace auth or
storage responses and accepts no external email. Assertions and timings are
retained in `reset-capacity-proof.json` and the four scenario receipts.

### Fresh native Linux window and tray proof

Create a new measured stage at the final prepared local head, build the native
app with that exact manifest, and run the retained lifecycle harness:

```sh
python3 rust/scripts/stage-desktop.py --web web --node /opt/agent-fleet/bin/node \
  --output /persist/home/evidence/pr132-vm135-20261011/native-stage \
  --commit "$(git rev-parse HEAD)"
PP_DESKTOP_RELEASE_MANIFEST=/persist/home/evidence/pr132-vm135-20261011/native-stage/bundle-manifest.json \
  cargo build --locked --manifest-path rust/Cargo.toml -p pp-desktop --message-format=json
/usr/bin/python3 /persist/home/evidence/pr132-vm135-20261011/desktop-lifecycle-proof.py \
  <executable-from-compiler-artifact> \
  /persist/home/evidence/pr132-vm135-20261011/native-stage
```

The harness uses fresh temporary data and the real native window on `:99`.
It records the app/core and Node child identities, closes the window, checks
that it hides while those processes stay alive, activates **Show Print Partner**,
and checks that the same window returns. It activates **Quit Print Partner**,
checks exit status 0, child reap, marker/lease/runtime/socket cleanup, and
re-locks the retained `.desktop.lock` file.

**No literal click was done for the menu item activations.** Show Print Partner
and Quit Print Partner are triggered through the app's own
`com.canonical.dbusmenu` over D-Bus. The evidence CLI's `tray-click` command
right-clicks the tray icon to open the native menu for its screenshot. The
display's watcher reports an empty RegisteredStatusNotifierItems property even
while its bridge renders the icon, so the harness locates the exported menu on
a D-Bus connection belonging to the owned native PID.
The evidence CLI captures the real app window and tray menu. Inspect the two
PNGs before publishing:

- `pr132-vm135-window.png`
- `pr132-vm135-tray.png`
- `desktop-lifecycle-proof.json` and `desktop-process.log`

These are unsigned Linux desktop smoke evidence and isolated Rust auth HTTP
evidence. They do not establish macOS behavior, external OAuth, successful live
SMTP, PostgreSQL, or full application acceptance. No LAN instance was used.

## Coordinator handoff

Keep this worktree and its local commits. Push only after #128 lands and the
coordinator explicitly authorizes `git push origin HEAD:desktop/auth-http`.
Then publish reviewed local artifacts, append refreshed evidence to the PR body,
and reply to the fixed P1 with the pushed commit SHA. No rebase, force-push, or
PR merge is part of this preparation.
