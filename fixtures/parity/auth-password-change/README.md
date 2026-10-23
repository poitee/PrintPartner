# Password-change parity (GRE-873)

`node.json` records public `POST /auth/change-password` responses from
`web/apps/server/src/routes/auth.ts`, plus whether the old and new passwords
still authenticate before and after each request.

Cases cover a missing cookie, a wrong current password, a valid change,
malformed password fields, and nonempty invalid or revoked cookies (including
when the body is empty). Node resolves the session in `onRequest` before field
validation, so those stale cookies return `401 {"detail":"Authentication required"}`
rather than a field error.

Regenerate or verify from the repo root with Node 22 after `npm --prefix web ci --ignore-scripts`:

```sh
node fixtures/parity/auth-password-change/generate.mjs
node fixtures/parity/auth-password-change/generate.mjs --check
```

`rust/crates/pp-api/tests/auth_password_change_parity.rs` replays the corpus
through `auth_router` with `desktop_rebuild`. It requires the feature; default
builds skip the binary. Password and session policy are unchanged.

```sh
CARGO_TARGET_DIR=/persist/targets/<branch> \
  cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --features desktop_rebuild --test auth_password_change_parity
```
