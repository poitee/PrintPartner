# Reset-request parity (GRE-864)

`node.json` records the public `POST /auth/forgot-password` contract from `web/apps/server/src/routes/auth.ts` for three cases: a known account whose loopback mail is accepted, an unknown account, and a known account whose loopback mail is rejected. The three public responses are the same generic body. The golden also records delivery and reset-token counts, and the mail-failure error class. It does not record addresses, tokens, or provider text.

`generate.mjs` builds the real Fastify app over a disposable data directory and a loopback SMTP fake. Regenerate or verify from the repo root with Node 22.23.3 after `npm --prefix web ci --ignore-scripts`:

```sh
node fixtures/parity/auth-reset/generate.mjs
node fixtures/parity/auth-reset/generate.mjs --check
```

`rust/crates/pp-api/tests/auth_reset_parity.rs` replays the same three requests through `auth_router`. It uses the pooled auth client by default and the rebuild client with `desktop_rebuild`. Mail goes to a loopback cleartext fake through `ResetMailer::loopback_cleartext_for_tests`. That constructor is a test seam. The desktop binary does not call it, and product mail stays on `ResetMailer::smtp`.

The failure case checks the existing GRE-506 log line. The line must be the redacted class and must not contain a fixture address or token. A copy of the public body that adds provider or account text fails `disclosing_response_body_fails_the_contract`.

```sh
CARGO_TARGET_DIR=/persist/targets/gre-864-auth-reset-parity \
  cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_reset_parity
CARGO_TARGET_DIR=/persist/targets/gre-864-auth-reset-parity \
  cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --features desktop_rebuild --test auth_reset_parity
```
