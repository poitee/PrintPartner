# Auth admission parity

Refs GRE-877. Seventy-seven cases use real loopback HTTP to compare auth admission.
They cover registration, forgot-password, login, logout, password change, seeded reset-password,
authenticated `/auth/me`, and API-key creation, revocation, and regeneration.
Login also covers a second Host or Origin header and each of `X-Forwarded-Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, and `Forwarded`.
The generator uses Node's full `buildApp` with CORS reflection enabled and explicitly configured loopback SMTP.
Rust replays the same closed recipes through the public auth router, using pooled storage by default and rebuild storage with `desktop_rebuild`.
The Rust test owns sixty-five literal response differences and checks both complete public error objects.
Sixty-one are security corrections. Four are HTTP error mappings, including guard-before-body ordering.

Node 22.23.3 is the canonical runtime, with web dependencies installed by it and contracts/domain built.
Capture and plain `--check` exit 2 on any other Node version. `--check --additional-runtime` compares another runtime
against the canonical golden and labels the result, but never writes it.
The `Auth admission freshness` workflow runs the canonical check when the fixture, server, authority packages, lockfile, or `.nvmrc` change.
The Rust freshness test uses `PP_TEST_NODE` or `node` in additional-runtime mode, so Linux Rust CI on Node 24 keeps that coverage.
It is ignored on macOS, where runners intermittently reset the probe's upload with `write ECONNRESET` before the response is read.

```sh
node --conditions=development fixtures/parity/auth-admission/generate.mjs
node --conditions=development fixtures/parity/auth-admission/generate.mjs --check
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml -p pp-api --test auth_admission_parity
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml -p pp-api --test auth_admission_parity --features desktop_rebuild
```

Every refusal independently requires unchanged full rows and counts across all principals in `users`, `sessions`,
`password_reset_tokens`, `auth_identities`, and `app_settings`, plus `sqlite_sequence` when present and zero SMTP connections after drain.
Snapshots stay local. They detect persistent row changes, but cannot prove the absence of rolled-back writes or UUID insert/delete churn.
No audit schema is installed. Productive controls require actual user/session, reset-token, or API-key writes, cookies where applicable, and route success fields.
Authenticated `/auth/me` controls require unchanged storage and no new session cookie.
Reset controls consume a seeded token, replace the old session, and change the password hash.
API-key controls seed an active key through HTTP, then prove creation, deactivation, or rotation in `api_keys_v1`.
Node completes an SMTP message. Rust attempts SMTP and fails because the fake does not offer required STARTTLS.
Rust drains the real delivery window before counting traffic. Neither runtime disables mail or uses a sleep to prove zero traffic.

Each case owns disposable storage and ephemeral listeners. Cleanup runs before comparisons, with HTTP stop bounded to ten seconds,
mail drain to twenty-five seconds, and a forty-five second case budget. Body recipes retain byte length and SHA-256 rather than padding.
Host and Origin are symbolic, so no ephemeral ports, generated IDs, tokens, cookies, or large bodies enter the golden.

This bundle adds four seeded reset-password cases, eleven `/auth/me` cases, and thirty API-key cases.
`/auth/me` covers foreign Origin, cross-site `Sec-Fetch-Site`, duplicate Host and Origin, all four proxy headers,
and allowed missing Origin on GET. Each API-key mutation covers the four basic admission recipes plus duplicate and proxy headers.
`GET /settings/api-keys`, the OAuth start and callback routes, and bounded-body or invalid-JSON recipes outside forgot-password remain a follow-up slice.
