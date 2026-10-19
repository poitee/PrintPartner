# Settings API-key parity (GRE-866)

`node.json` records Node's `/settings/api-keys` contract. `generate.mjs` runs the real Fastify routes from `web/apps/server/src/routes/api-key-management.ts` and `validateApiKey` against a temporary data directory, through a fixed list of steps:

- List, create, revoke and regenerate requests. Each step records the status and the complete response body.
- Key use (`validateApiKey`), recorded as the accepted key ID or `null`. This covers active, revoked, rotated, unknown and expired keys.
- Reopen, which closes the database, sets `expiresAt` on stored keys to a fixed past or future time, and opens it again. Revocation and expiry must survive it.
- Tenant isolation. Steps marked `"as":"foreign"` run in a second tenant, set per request the way production's tenant hook does. That tenant creates and uses its own key. It cannot see, use, revoke or regenerate the owner's key, and the owner cannot use its key.

The golden stores no secret. Generated keys, key IDs and `createdAt`/`lastUsedAt` values become tokens such as `<key:1>`, `<id:1>` and `<id:1.createdAt#1>`. Tokens are assigned in order of issue, so a value that recurs keeps its token and a changed time gets a new version. Only a time in `toISOString` form is tokenized. Any other value stays literal. Time links are kept per key and field. A `createdAt` that equals a `lastUsedAt` only means two events fell in the same millisecond, so linking them would make the golden depend on timing.

Before normalizing, both sides check the raw output. An issued key may appear only as the `key` field of the create or regenerate response that issued it. A key or key ID may be issued only once. No raw string may look like a token (`<id:…>` or `<key:…>`), because it would compare equal to the token it imitates. The generator refuses to write a raw `ppk_` key, generated ID or generated time.

`rust/crates/pp-api/tests/auth_key_parity.rs` replays the same steps through `auth_router` with two registered accounts, the owner and the foreign account, each in its own tenant. Key use goes through `Request::ResolveKey` for the step's tenant. The test normalizes Rust output with the same rules and strictly compares each step's status and complete response body with Node's recorded output. Unknown and foreign key IDs return `{"detail":"API key not found","title":"Not Found","status":404}`. It also checks:

- Stored keys hold digests only, and revocation persists across a reopen.
- The comparison fails when raw Rust output puts a key in a list entry, a `createdAt` or an error `detail`, when a time is malformed or changes, when a raw value imitates a token, when a key is issued twice, or when a revoked key is accepted.

Node never sets `expiresAt` when it creates a key. Lifetime-based expiry in the `desktop_rebuild` auth client has no Node counterpart and is not compared here.

## Regenerate and check

Run from the repository root with Node 22 and `npm --prefix web ci`:

```sh
node fixtures/parity/auth-key/generate.mjs --check
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test auth_key_parity
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test auth_key_parity
```

Without `--check`, the generator rewrites `node.json`.
