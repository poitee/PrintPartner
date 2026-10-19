# Auth session parity

Run these commands from the repository root with Node 22 and installed web dependencies:

```sh
node fixtures/parity/auth-session/generate.mjs
node fixtures/parity/auth-session/generate.mjs --check
cd rust
cargo test -p pp-api --features desktop_rebuild --test auth_session_parity -- --nocapture
```

The generator runs the current Node auth routes, cookie plugin, and tenant middleware against a disposable SQLite database. It creates an account and session through `AuthStore`. Before any requests, it replaces random and time-dependent seed values with fixed inputs. Expected responses come from the routes. `--check` repeats the capture without writing the fixture.

The feature-mode Rust command runs two tests. `node_session_fixture_is_current` runs the real generator with `--check` and fails if the committed fixture is stale. It requires Node 22 and installed web dependencies, including the native SQLite module. It selects the executable from `PP_SCHEMA_PARITY_NODE`, then `PP_TEST_NODE`, then `node` on `PATH`. Missing Node or dependencies fail the test. `node_session_transitions_match_real_auth_router` compares the captured transitions with Rust.

`node.json` contains the seed and seven ordered session transitions. An absent-cookie logout runs while the original session still exists. The next logout revokes that session. Later requests replay the original credential, including after the database and server reopen.

The Rust test creates a disposable current-schema database from the seed and sends the recorded requests through the real `auth_router` over loopback HTTP. It uses `RebuildAuthClient` through `WriterOwner::rebuild_auth_with_policy`, matching the desktop rebuild router. Each transition compares exact status, complete public JSON, clearing cookies, and persisted session row count. The test is gated by the default-off `desktop_rebuild` feature. The generator does not activate a production flag.

Cookie comparison preserves the name, value, path, domain, Secure, SameSite, and immediate-expiry effect. Max-Age takes precedence over Expires. Node clears with both `Max-Age=0` and an epoch Expires date. Rust clears with `Max-Age=0`. Rust also sets HttpOnly on the deletion header. HttpOnly does not change cookie identity or deletion. The credential is empty and expires immediately. Node's exact headers remain in the fixture, and `--nocapture` prints both implementations' exact headers. No live session issuance attributes are normalized by this test.

Both runners close their servers and databases and remove disposable data. The seed credential is public test data.

To reproduce the mutation check, back up `node.json`. In the case named `logout`, temporarily change `expected.body.ok` from `true` to `false`. Run the focused Rust command above. Expect the freshness test to fail with `node.json is out of date` and the route test to fail with `transition logout`. Restore the original fixture, then run these commands from the repository root. Both must pass:

```sh
node fixtures/parity/auth-session/generate.mjs --check
(cd rust && cargo test -p pp-api --features desktop_rebuild --test auth_session_parity -- --nocapture)
```
