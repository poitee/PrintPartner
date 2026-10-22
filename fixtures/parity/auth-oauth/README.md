# OAuth callback parity

`node.json` records Node's registered auth callbacks for GitHub and Discord. The generator drives `registerAuthRoutes` and keeps provider token, profile, and email HTTP on a loopback fake. Raw client secrets, access tokens, state, and session values never enter the golden.

The Rust consumer drives `auth_router` with the rebuild auth client. `ProviderClient::redirect_exchange_to_loopback_for_tests` points only the exchange URLs at the same kind of loopback fake. Authorize URLs stay on the public providers, and the override rejects any origin that is not bare `http://127.0.0.1:<port>`. The method exists only in `desktop_rebuild` builds. Nothing in the router calls it.

Both sides cover a missing state, a changed state, a provider token denial, and a successful callback followed by a replay of that same callback. The replay resends the original state and browser cookie.

These differences are intentional and both sides stay in the comparison:

- Rust keeps one server-side flow and removes it before calling the provider. A replay after success or denial is 400 `Invalid OAuth state` and does not create another session. Node treats the resubmitted cookie as the state, so the same callback creates a second session, and a denied code can be presented again.
- Node copies the provider `error` field into a 401 `access_denied` body. Rust returns 401 `OAuth failed` and does not copy provider error text.
- Both set `pp_session` with `HttpOnly`, `Path=/`, `SameSite=Lax`, and `Max-Age=1209600`. Node's `oauth_state` clear cookie adds `Expires` and omits `HttpOnly`. Rust's clear cookie is `HttpOnly` and has no `Expires`.
- Rust GitHub sends a PKCE verifier whose SHA-256 matches the authorization challenge. Node does not send PKCE.
- Both skip GitHub email enrichment once that identity is already linked.

A changed success redirect and a replay that created another Rust session fail the comparison. Reusing a generated state, browser binding, or PKCE challenge fails before normalization.

```sh
node fixtures/parity/auth-oauth/generate.mjs
node fixtures/parity/auth-oauth/generate.mjs --check
PP_SCHEMA_PARITY_NODE=/path/to/node22 cargo test --manifest-path rust/Cargo.toml \
  -p pp-api --features desktop_rebuild --test auth_oauth_parity
```

The tests are behind default-off `desktop_rebuild`. The freshness test invokes Node 22. `PP_SCHEMA_PARITY_NODE` selects that executable. Without it, the test invokes `node` from `PATH` and the generator still requires version 22.

Windows does not run this suite. `.github/workflows/rust-cross-os.yml` excludes `pp-api` from the Windows package scope.
