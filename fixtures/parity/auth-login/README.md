# Login and registration failure parity

`node.json` records 14 responses from the registered Node authentication handlers.
The Rust test sends the same requests to the landed `pp_api::auth::auth_router`
over an ephemeral IPv4 loopback listener. It compares the HTTP status, the
complete public JSON body, and every `Set-Cookie` header.

Both runtimes send a same-origin `Origin` header. `generate.mjs` sends
`Host: 127.0.0.1` and `Origin: http://127.0.0.1`, and records
`sameOriginRequests: true` in the fixture configuration. The Rust test sends
the loopback listener's own origin. The Rust router rejects unsafe methods
such as `POST` without `Origin` with HTTP 403 and
`{"detail":"Invalid request origin"}` before authentication handling. The
registered Node auth routes do not enforce this Origin requirement; adding the
header left all 14 recorded Node responses unchanged. This harness does not
establish Origin or CSRF enforcement parity.

Eleven cases require exact equality. Three cases assert explicit Rust security
differences. The test does not claim parity for those cases or for successful
login responses.

## Capture the Node responses

Use Node 22 and the dependencies locked in `web/package-lock.json`.
Run these commands from the repository root.

```sh
npm --prefix web ci
node fixtures/parity/auth-login/generate.mjs
node fixtures/parity/auth-login/generate.mjs --check
```

`generate.mjs` imports the actual `registerAuthRoutes` and
`registerTenantMiddleware` functions from `web/apps/server/src/routes/auth.ts`.
It registers them on Fastify with `@fastify/cookie`, following the route-level
setup in `web/apps/server/src/routes/auth-security.test.ts`. Requests pass
through Fastify's JSON parser and registered handlers with `app.inject`.
No handler function is extracted, copied, or reconstructed.

Each case opens a fresh `SqliteDatabase` in a unique temporary directory.
The production migrations initialize that database. A real `AuthStore` uses
that connection. The configuration selects authenticated single-user self-host
mode, disables OAuth, and uses a non-Secure cookie for loopback HTTP.
The capture child receives only `PATH` and `NODE_ENV=production`. It does not
load deployment configuration or read credentials. It closes Fastify and the
database before removing its own temporary directory, including on failure.

The bad-password and administrator-exists cases first register the fixture
account through `/auth/register`. Each also performs a successful `/auth/login`
and checks its status, complete body against registration, and session cookie
attributes. These positive controls establish that the account exists and its
password works. Their random identifiers and tokens are not recorded or used
in the failure comparison.

The fixture stores a table of named cases. Each case includes the registration
policy, whether to create an account, the raw JSON request text, and the literal
response `{status, body, setCookie}`. JSON property order is immaterial. No
fields, messages, error codes, cookie values, or headers within `Set-Cookie`
are removed or normalized. All 14 captured failures have an empty `setCookie`
array. The tests reject an unexpected session cookie on any failure.

## Cases and intentional differences

Exact matches cover unknown accounts, bad passwords, empty objects, missing
email, missing password, wrong email types, wrong password types, disabled
registration, an existing single-user administrator, invalid registration
email, and short registration passwords.

Rust has a strict JSON-object boundary and a fixed public parse-error message.
The following cases preserve that security behavior without changing production
authentication code.

- `array-body` returns Node 400 with `{"detail":"Email and password are required"}`.
  Rust returns 400 with `{"detail":"Invalid JSON body"}` because arrays are not objects.
- `null-body` returns Node 500 with its complete Fastify error body, including
  `"Cannot read properties of null (reading 'email')"`. Rust returns 400 with
  `{"detail":"Invalid JSON body"}` and does not expose that internal exception.
- `malformed-json` returns Node 400 with Fastify's `statusCode`, `code`, `error`,
  and `message` fields. Rust returns 400 with `{"detail":"Invalid JSON body"}`.
  Rust does not expose parser details in its public response.

For each difference, the test first requires comparison with the unchanged Node
response to fail. It then requires equality with the complete literal Rust
response, including an empty cookie list. These are named exceptions, not a
general error conversion or a subset comparison.

## Run the Rust checks

The test follows `rust/crates/pp-api/tests/auth_http.rs`. Every case owns a fresh
temporary database, a `WriterOwner`, and a loopback listener. Open registration
maps to `RegistrationPolicy::FirstAccountOnly`; disabled registration maps to
`RegistrationPolicy::Closed`. The test sends the raw request text with
`Content-Type: application/json` and the listener's `Origin`. It uses no proxy
and follows no redirects. It shuts down the server and writer before removing
the temporary directory.

On the development VM, run through the fleet Cargo wrapper.

```sh
export CARGO_BUILD_JOBS=3
export RUSTC_WRAPPER=/opt/agent-fleet/bin/sccache
export SCCACHE_DIR=/persist/sccache
export SCCACHE_SERVER_PORT=4227
export CARGO_TARGET_DIR=/persist/build-targets/gre-862
/persist/home/.local/bin/cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_login_parity -- --nocapture
/persist/home/.local/bin/cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_login_parity --features desktop_rebuild -- --nocapture
```

The target has two tests. The loopback test checks all 14 responses and requires
exactly 11 matches and three named differences. The comparator test rejects 95
mutations across the Node responses and explicit Rust expectations. It changes
the status, changes and removes every public JSON field, adds a JSON field, and
adds a cookie. Equality checks the entire response structure.

## Scope and test structure

A full `buildApp` fixture would include unrelated route registration and service
setup. The route-level Fastify structure is smaller and still executes the
registered authentication handlers, JSON parser, cookie plugin, and real
database operations. This fixture uses that structure and the existing Rust
loopback pattern. It adds no production dependencies or authentication changes.

The positive controls check local success behavior. They do not establish
cross-runtime parity for random account identifiers, session tokens, or cookie
serialization. TLS cookies, browser behavior, OAuth, password reset, logout,
rate limits, CSRF rejection, timing, and account enumeration timing remain
outside this slice. No rebuild feature or runtime flag changes in this slice.
