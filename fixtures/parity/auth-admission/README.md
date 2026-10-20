# Auth admission parity

Refs GRE-877. Fourteen cases use real loopback HTTP to cover registration and password reset admission.
The generator uses Node's full `buildApp` with CORS reflection enabled and explicitly configured loopback SMTP.
Rust replays the same closed recipes through the public auth router, using pooled storage by default and rebuild storage with `desktop_rebuild`.
The Rust test owns eleven literal response differences and checks both complete public error objects.
Seven are security corrections. Four are HTTP error mappings, including guard-before-body ordering.

Generate with Node 22.23.3 as the canonical capture runtime, after installing web dependencies and building contracts/domain.
The freshness test defaults to `node`; set `PP_TEST_NODE` to the binary matching the installed native modules.

```sh
node --conditions=development fixtures/parity/auth-admission/generate.mjs
node --conditions=development fixtures/parity/auth-admission/generate.mjs --check
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml -p pp-api --test auth_admission_parity
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml -p pp-api --test auth_admission_parity --features desktop_rebuild
```

Every refusal independently requires unchanged full rows and counts across all principals in `users`, `sessions`,
`password_reset_tokens`, and `auth_identities`, plus `sqlite_sequence` when present and zero SMTP connections after drain.
Snapshots stay local. They detect persistent row changes, but cannot prove the absence of rolled-back writes or UUID insert/delete churn.
No audit schema is installed. Productive controls require actual user/session or reset-token writes, cookies, and route success fields.
Node completes an SMTP message. Rust attempts SMTP and fails because the fake does not offer required STARTTLS.
Rust drains the real delivery window before counting traffic. Neither runtime disables mail or uses a sleep to prove zero traffic.

Each case owns disposable storage and ephemeral listeners. Cleanup runs before comparisons, with HTTP stop bounded to ten seconds,
mail drain to twenty-five seconds, and a forty-five second case budget. Body recipes retain byte length and SHA-256 rather than padding.
Host and Origin are symbolic, so no ephemeral ports, generated IDs, tokens, cookies, or large bodies enter the golden.

Additional endpoints, duplicate and forwarded headers, and CI workflow wiring remain a follow-up slice.
