# Settings API-key parity (GRE-866)

`node.json` records Node's `/settings/api-keys` contract. `generate.mjs` runs the real Fastify routes from `web/apps/server/src/routes/api-key-management.ts` and `validateApiKey` against a temporary data directory, through a fixed list of steps:

- List, create, revoke and regenerate requests. Each step records the status and the complete response body.
- Key use (`validateApiKey`), recorded as the accepted key ID or `null`. This covers active, revoked, rotated, unknown and expired keys.
- Reopen, which closes the database, sets `expiresAt` on stored keys to a fixed past or future time, and opens it again. Revocation and expiry must survive it.

The golden stores no secret. Generated keys, key IDs and `createdAt`/`lastUsedAt` values become tokens such as `<key:1>`, `<id:1>` and `<id:1.createdAt#1>`. Tokens are assigned in order of issue, so a value that recurs keeps its token and a changed time gets a new version. Any other value stays literal. The generator refuses to write a raw `ppk_` key, generated ID or generated time.

`rust/crates/pp-api/tests/auth_key_parity.rs` replays the same steps through `auth_router` for one registered account. Key use goes through `Request::ResolveKey` for that account's tenant. The test normalizes Rust output with the same rules and compares each step for equality. It also checks:

- Stored keys hold digests only, and revocation persists across a reopen.
- The comparison fails when a list body carries a key, when a revoked key is accepted, or when a stable time changes.
- A second account cannot see, use, revoke or regenerate the first account's key. Revoke and regenerate return Node's unknown-ID response. Node has one tenant, so this check is Rust-only.

## Known gap

For an unknown key ID, Node's `sendProblem` returns `{"detail":"API key not found","title":"Not Found","status":404}`. Rust's shared auth `Failure` returns only `detail`. `rust_contract` in the test accounts for exactly this difference. Remove it when the auth error body matches.

Node never sets `expiresAt` when it creates a key. Lifetime-based expiry in the `desktop_rebuild` auth client has no Node counterpart and is not compared here.

## Regenerate and check

Run from the repository root with Node 22 and `npm --prefix web ci`:

```sh
node fixtures/parity/auth-key/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test auth_key_parity
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test auth_key_parity
```

Without `--check`, the generator rewrites `node.json`.
