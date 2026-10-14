# GRE-353 PR 375 score, round 1

Head: `ea4ef84dbf6a92c08ffb0d96bf2fc1a09f5f0ac4`

Score: **10 / 10**. Gate: pass. Criteria confidence: 1. Visual: null.

Local `HEAD`, `origin/owner/gre353-next-202610141227-9efa`, and GitHub PR 375 `headRefOid` are that full SHA. The worktree was clean before and after the independent runs. `mergeStateStatus` is `CLEAN`. `gh pr checks` on this head is 21 pass and 2 completed skips (`bundle (macos-26-intel)`, `slicer-sidecar`). Nothing is queued, in progress, or failing. `checks-final.json` matches this head with `tests_green` true and empty `still_running`, `failing`, `new_errors`, and `out_of_scope`.

This score covers the explicit same-id account mapping slice. It does not complete GRE-353.

## Rubric

| Item | Points | Result |
|---|---|---|
| Acceptance criteria | 5 | 5. Confidence 1. No UI, so the screenshot points sit on criteria. |
| Tests and CI green, nothing still running | 2 | 2. Live checks settled. Independent Node and gateway runs exited 0. |
| Screenshot | 0 | Not scored. `visual` is null. |
| No new runtime errors | 2 | 2. Independent suites passed. CI `new_errors` is empty. |
| Diff scope | 1 | 1. 22 files, 1437 insertions, 58 deletions, 1495 changed lines. |
| Total | 10 | 10 |

## Criteria

Admission is explicit and fails closed. `desktop-account.json` must be version 1, kind `existing-account`, at most 4096 bytes, mode `0600`, owned by the current user, and a regular file opened with `O_NOFOLLOW`. `user_id` and `tenant_id` must be the same non-`default` id. Unknown fields, a missing user, a mismatched tenant, and a schema other than the current version throw before the mapped account is returned. Core captures the pin only after `prepare_directory` and `StorageLease::acquire`. With either gate off, capture stays `Disabled`, setup bytes stay unchanged, and an existing `users` row still refuses startup. An empty directory with both gates on stays the synthetic `desktop-owner`.

The signed transport assertion remains `tenant=default` and `actor=desktop-owner`, checked with HMAC and a 30 second window before any mapped principal is installed. A forged `x-pp-principal` does not select another tenant. Each authenticated request rereads email, display name, password presence, and `is_admin`. Demotion stays on account A and then receives 403 on an admin route. Deletion returns 401 for `/auth/me` and a later plan write. Replacing the mapping file during the same Core process does not switch the session to account B.

Own-tenant plan reads and writes succeed on `/plans`, `/api/v1/plans`, and `/api/v2/plans`. Foreign and `default` plans return 404, including with `tenant_id` and `x-tenant-id`. The nonadmin fixture is not elevated: settings, slicer, integration, webhook, and backup restore return 403. `/admin/import-kit-bundle` stays unavailable. Mapped startup uses `existing-current-schema`, skips migrations, starter seeding, legacy export and manifest migration, outcome conversion, Advisor backfill, and backup registration. Health omits `backups`, `multi_user_auth`, `password_reset_email`, `github_oauth`, and `discord_oauth`, and reports registration closed. Gateway account-mutation and OAuth paths return 501. Backend registration of those routes, including logout and dev-login, returns 404 and leaves users, sessions, identities, and reset rows unchanged.

The mapping pin is one immutable value on `SpawnSpec.account_pin`, applied on every compatibility spawn. A changed, newly appeared, or removed mapping makes the restarted child unavailable (HTTP 503) and does not adopt the new account. A full Core restart reads the new pin and can select account B. Replacing the database, including through a symlink alias, changes the inode and later authenticated requests return 401. `SpawnSpec` always has `account_pin`. Enabling only `pp-compat/desktop_rebuild` still leaves Core's gate off and refuses the populated database without writing it.

Direct shutdown sets `printerUploadsHalted` before repository access. A late upload success is recorded as the interrupted error, the artifact bytes remain, and a foreign `sending` queue row stays unchanged for a scoped or unavailable-database shutdown.

## Independent evidence

Stage used, not rebuilt: `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/exact-ea4ef84dbf6a-stage`. `bundle-manifest.json` and `release.json` commit are `ea4ef84dbf6a92c08ffb0d96bf2fc1a09f5f0ac4`. Manifest SHA-256 is `f8e351da43c7574b9de308d612d2fdc60d2918865b2a197cc6e99d52ff4ad466`. Node is `v24.21.0`. All 22 diff paths hash-match `exact-ea4ef84dbf6a/head-proof.json`. That proof file's git blob is `a538b441391c35b0006874ce0c15f55a90247f7b`, the same blob published at `7cf9e4acd1d75b6e0cba6bf85e19e2ccb50bda6f` path `ea4ef84dbf6a/head-proof.json`. `rust/Cargo.lock` is unchanged versus `origin/main`. `rustls` remains `0.23.46` checksum `48e13bd8c0e9365c43cfa5c9e8f9ad49d3c8444926c9aac819e0e4dc503c8fdf`.

Runs used `land.py slot`, one Cargo feature set at a time, `CARGO_BUILD_JOBS=4`, target `/persist/home/.local/state/pstack-t3/gre353-next/target`, and `PP_DESKTOP_REBUILD` unset in the parent. The gateway child is `env_clear` and receives the pin only on the setup pipe.

- Node 24.21.0, 92 passed, 17.89s: `grok-r1/node-tests.log`. Includes admission refusals, mapped auth 404s with an unchanged SQLite snapshot, health capability omissions, and 7 upload-shutdown tests. The file count is 2 direct cases, 3 direct-upload shutdown modes (`unscoped`, `mapped`, `unavailable`), and 2 in-flight tenant shutdown modes.
- Feature `desktop_rebuild` on, 9 passed, 38 skipped, 156.938s: `grok-r1/mapping-on.log`. Fresh synthetic owner, demotion and deletion, alias replacement, runtime gate off, own and foreign plans across restart, three pin crash cases, and nine pre-write refusals whose database bytes stayed equal.
- Feature off, 2 passed, 45.388s: `grok-r1/mapping-off.log`.
- `--features pp-compat/desktop_rebuild` only, 2 passed, 45.259s: `grok-r1/mapping-mixed.log`. Both refusals ran with Core's own gate off.

Preflight and postflight: `grok-r1/preflight.txt`, `grok-r1/postflight.txt`, `grok-r1/mapping-mixed.meta`. Head stayed `ea4ef84dbf6a92c08ffb0d96bf2fc1a09f5f0ac4` and the porcelain status stayed empty.

## Findings

No material blockers.

Negative-path lines in `node-tests.log` are the asserted results: missing auth routes log `not found` at 404, and the upload suite completes the interrupted job as an error while retaining the artifact. The suite exit code is 0.

## Limits

Legacy `default` tenant data is still unsupported. Native handoff, macOS, and signed release acceptance are not claimed. Live external in-place database replacement remains unsupported. This run did not rebuild the web bundle or repeat clippy, fmt, typecheck, or the full `runtime_m0` lifecycle; those are covered by the settled Desktop runtime, Rust, and web checks on this SHA. The parent owns merge.
