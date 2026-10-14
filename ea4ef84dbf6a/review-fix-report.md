# GRE-353 review correction

Committed locally at `8e39f7a72d6faeb203603b59565b81d86ef70689` on `owner/gre353-next-202610141227-9efa`.
The parent head is `99517b342adfdc4c635c069642dc4e07058fc3d6`. The recorded main base is `f73756f7d2b8b6aa1fbcb4950c040f96ede5b746`.
The worktree is clean. No children, push, PR changes, merge, scoring, remote deletion, rustls update, or contact to Chad occurred.
The parent retains sole PR375 ownership, independent review, exact-head rebuild, CI, and Grok Build scoring. The prior provider flag remains in the parent record. This correction encountered no provider restriction.

The correction changes 7 allowed files with 128 additions and 27 deletions, totaling 155 changed lines.
The net mapping slice changes 22 files with 1437 additions and 58 deletions, totaling 1495 changed lines.
Reproduce those totals with `git diff --numstat 99517b342adfdc4c635c069642dc4e07058fc3d6 8e39f7a72d6faeb203603b59565b81d86ef70689` and `git diff --numstat f73756f7d2b8b6aa1fbcb4950c040f96ede5b746 8e39f7a72d6faeb203603b59565b81d86ef70689`.

## Account mutation admission

`registerAuthRoutes` returns after registering the read-only `/auth/me` route when the account is mapped. Backend logout, dev-login, password login, registration, forgot/reset/change password, and all OAuth route registration share that admission. Existing mapped authentication middleware and tenant isolation remain in place.

The pre-fix Node test with NODE_ENV absent returned 200 for dev-login rather than 404. Its failure remains in `review-fix-r1/node-dev-login-red.log`. The earlier backend logout reproduction returned 200 rather than 404 in `review-fix-r1/node-auth-shutdown-red.log`.

The final Fastify test enables registration, password email, and both OAuth configuration switches. It preserves `/auth/me`, asserts 404 for all eleven backend mutation and OAuth routes, and compares real SQLite users, sessions, identities, and password-reset rows before and after. The fixture includes a selected account, foreign account, and foreign session. Existing unmapped registration, login, session, password, OAuth, and health tests pass.

The public Rust gateway already denies ten account mutation and OAuth paths with 501. The initial gateway-red test incorrectly expected backend 404 at that gateway. Its raw denial statuses remain in `review-fix-r1/gateway-red.log`. The final gateway test preserves the correct 501 contract and confirms unchanged foreign and global auth rows through startup, requests, shutdown, and restart. Gateway `/auth/logout` remains its existing runtime shutdown action. Only backend logout registration is disabled.

## Scoped upload shutdown

`interruptPrinterUploadsOnShutdown` accepts an optional explicit tenant scope. It always sets the process halt flag before repository access. With a scope it interrupts only that tenant and does not enumerate other tenants. Unscoped server shutdown retains all-tenant interruption.

Mapped desktop stop now calls that operation. An invalid mapped database passes empty ports while retaining the scope, which halts late upload success without database access.

The pre-fix deferred-upload fixture executed the existing mapped stop path and the invalid-database path. Both completed with status done instead of error. The failure remains in `review-fix-r1/shutdown-red.log`. The final fixture requires the interrupted error, retained artifact bytes, and unchanged foreign sending row for scoped and unavailable-database shutdown. It also checks unscoped interruption of foreign rows and scoped interruption of an owned queued send. Existing upload assertions remain intact.

## Health capabilities

The health boundary captures the mapped account restriction and passes it to capability calculation. Mapped health omits backups and disabled account, password email, and OAuth capabilities. Registration is reported closed. Existing tenancy and other capabilities remain.

The pre-fix real gateway health advertised backups and multi_user_auth, recorded in `review-fix-r1/gateway-red.log`. Final gateway health omits those capabilities. A Node health test with all account configuration switches enabled confirms each disabled capability is absent. The unmapped health test confirms backups and every configured account capability remain advertised.

## Verification

All checks run under `python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot --`.
The rerunnable commands and per-command JSON receipts are in `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/verify.py` and the adjacent logs.
The environment uses native Node 24.21.0, CARGO_BUILD_JOBS=4, and `/persist/home/.local/state/pstack-t3/gre353-next/target`. Inherited PP_DESKTOP_REBUILD is removed. Cases set their gates in isolated subprocesses.

- node-tests passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/node-tests.log`.
- typecheck passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/typecheck.log`.
- web-build passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/web-build.log`.
- stage passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/stage.log`.
- fmt passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/fmt.log`.
- clippy-on passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/clippy-on.log`.
- clippy-off passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/clippy-off.log`.
- mapping-on passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/mapping-on.log`.
- mapping-off passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/mapping-off.log`.
- mapping-mixed passed. Log `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/mapping-mixed.log`.

The focused Node suite passed 93 tests. The feature-on mapping filter passed nine real gateway scenarios. Feature-off passed two gate controls, and the compat-only mixed feature configuration passed two more. Source diff and staged diff checks passed before commit.
All 13 recorded runtime fixture receipts exist without remaining owner markers. Receipts are in `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/runtime-receipts.json`.

The fresh stage is `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/stage/bundle-manifest.json`. It is stamped with precommit base `99517b342adfdc4c635c069642dc4e07058fc3d6`. It was rebuilt from corrected Node source and used for every final mapping filter. `/persist/home/.local/state/pstack-t3/gre353-owner-mapping/review-fix-r1/source-equivalence.json` records committed source hashes, manifest hash, and equality of all four changed staged JavaScript modules with the rebuilt dist. This is source-equivalent precommit unsigned Linux proof, not the parent's independent final-head rebuild. Parent must rebuild `8e39f7a72d6faeb203603b59565b81d86ef70689` before CI and scoring acceptance.

The full diff was inspected under deslop. No new comments, casts, suppressions, generic wrappers, or unrelated source changes were added. The checked brief sets one coupled boundary writer. No child or parallel source writer was used.

Model the Domain keeps the existing account discriminant and mapped tenant admission fact. Laziness Protocol retains the existing operations and module boundaries. Fix Root Causes requires the failing Node and deferred-upload repros before source edits. Test Behavior, Not Implementation requires real route results, SQLite row snapshots, artifact bytes, and queue states. Prove It Works uses the rebuilt product through the real Rust gateway. Type System Discipline adds no casts or permissive state bags.

## Changed paths

- `rust/crates/pp-core/tests/runtime_m0/ticket_t_68_desktop_account_mapping.rs`.
- `web/apps/server/src/desktop.ts`.
- `web/apps/server/src/routes/auth-security.test.ts`.
- `web/apps/server/src/routes/auth.ts`.
- `web/apps/server/src/routes/health.ts`.
- `web/apps/server/src/services/printer-send-queue.ts`.
- `web/apps/server/src/services/printer-upload-shutdown.test.ts`.

## Limits

This correction does not complete GRE-353. Legacy default-tenant mapping, native handoffs, Mac, and signed acceptance remain open. Live external in-place database replacement remains unsupported. CI and all scores belong to the parent and were not inspected or changed here. The earlier failures and provider history are preserved.
