# Reset-completion parity (GRE-872)

`node.json` records how Node's `POST /auth/reset-password` in `web/apps/server/src/routes/auth.ts` completes a reset, and what authentication state follows. `generate.mjs` builds the real Fastify app over a disposable data dir with SMTP off and dev reset links on, so no mail leaves the process. Reset requests themselves belong to GRE-864.

The golden holds 18 labeled steps and one observation per step. Each observation records:

- The exact HTTP status and JSON body. `user_id` becomes `<user_id>` and `dev_reset_url` becomes `<reset_url>`.
- Whether the step issued a `pp_session` cookie.
- Whether the step changed the user's stored password hash (`identity_write`).
- The user's session and reset-token row counts after the step.

The steps cover a missing token, an unknown token, a short replacement password that leaves the token usable, a successful reset, a replay of the consumed token, and an expired token. They also check which sessions and passwords authenticate afterward.

Tokens, passwords and sessions appear only as labels. Both sides derive each password from its label, so the golden holds no raw token, password or cookie.

`rust/crates/pp-api/tests/auth_reset_complete_parity.rs` replays the same steps against `pp_api::auth::auth_router`. It uses the pooled auth client by default and the rebuild client with `desktop_rebuild`. A second test puts the consumed token row back before the replay step. That test checks that the golden rejects a backend that accepts a used token twice.

Regenerate or verify from the repo root after `npm --prefix web ci --ignore-scripts`:

```sh
node fixtures/parity/auth-reset-complete/generate.mjs          # write
node fixtures/parity/auth-reset-complete/generate.mjs --check  # verify, no writes
```
