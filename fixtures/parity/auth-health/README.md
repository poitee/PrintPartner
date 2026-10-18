# Auth health comparison

GRE-865 compares registered Node auth middleware and health handlers with Rust's
`auth_router`. Each case uses a new temporary SQLite database and real stored
sessions. No provider, mail service, production server or existing data is used.

Run with Node 22 after `npm --prefix web ci`:

```sh
node --conditions=development fixtures/parity/auth-health/generate.mjs --check
```

Omit `--check` to regenerate `node.json` from the live registered Node handlers.
The generator asserts six nonzero cases before checking the entire snapshot.
Only Node's runtime version is normalized. The configured data directory is a
literal `<temporary>` because handlers do not use that field to open the fixture
database. App version and release fields remain part of the complete response.
A version bump requires regenerating this snapshot.

The Rust test holds explicit expected Rust responses and asserts every status
and the complete JSON body. It also compares status and every shared body field
with the Node snapshot and requires an exact list of intentional differences.
Node's entire body, including its capability list, is checked by `--check`.

```sh
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_health_parity
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_health_parity --features desktop_rebuild
```

Run affected `pp-api` tests and clippy in both feature modes before submitting.
The feature-mode comparison uses the rebuild auth client directly. It does not
activate `PP_DESKTOP_REBUILD` or exercise the full mapped desktop application.

## Intentional differences and legacy behavior

- Node advertises its complete application capability list. The standalone Rust
  auth router advertises configured OAuth providers only, empty in these cases.
- Node includes build, deployment, database and Google Drive details. Rust's auth
  router includes single-user setup, owner-mapping, OAuth configuration and
  degraded-auth details instead. These fields are captured in full.
- The policy case contains two stored accounts under single-user configuration.
  Node accepts the session and closes registration. Rust rejects ambiguous owner
  mapping, reports `authenticated=false`, preserves HTTP 200 and includes
  `degraded_detail="Explicit account owner mapping is required"`.
- Expired sessions are unauthenticated with HTTP 200 in both implementations.
- A closed Node database with a session cookie fails during the real auth read
  and returns Fastify's HTTP 500 error body. A stopped Rust writer returns HTTP
  503 with `Authentication temporarily unavailable`.
- The additional anonymous closed-owner case records a legacy Node bug. Its
  multi-user health handler ignores `ping()` returning false and reports HTTP
  200 with `ok=true` and `db.connected=true`. Rust still returns HTTP 503. This
  difference documents the bug rather than treating the legacy success as the
  desired contract. A successful Rust response after stopping the owner fails
  both closed-owner tests. Fixing Node's ping handling needs a production slice.

This covers the owner-mapping policy rejection and a stopped writer. It does not
claim parity for every policy variant, configured OAuth providers or other
storage failure classes. GRE-507's existing unit tests cover the broader
policy-error and runtime-error classification, including errors during session
resolution after a successful status request.
