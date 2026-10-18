# Auth session parity

Run these commands from the repository root with Node 22 and installed web dependencies:

```sh
node fixtures/parity/auth-session/generate.mjs
node fixtures/parity/auth-session/generate.mjs --check
cd rust
cargo test -p pp-api --features desktop_rebuild --test auth_session_parity -- --nocapture
```

The generator runs the current Node auth routes, cookie plugin, and tenant middleware against a disposable SQLite database. It creates an account and session through `AuthStore`. Before any requests, it replaces random and time-dependent seed values with fixed inputs. Expected responses come from the routes. `--check` repeats the capture without writing the fixture.

`node.json` contains the seed and seven ordered session transitions. An absent-cookie logout runs while the original session still exists. The next logout revokes that session. Later requests replay the original credential, including after the database and server reopen.

The Rust test creates a disposable current-schema database from the seed and sends the recorded requests through the real `auth_router` over loopback HTTP. Each transition compares exact status, complete public JSON, clearing cookies, and persisted session row count. The test is gated by the default-off `desktop_rebuild` feature. The generator does not activate a production flag.

Cookie comparison preserves the name, value, path, domain, Secure, SameSite, and immediate-expiry effect. Max-Age takes precedence over Expires. Node clears with both `Max-Age=0` and an epoch Expires date. Rust clears with `Max-Age=0`. Rust also sets HttpOnly on the deletion header. HttpOnly does not change cookie identity or deletion. The credential is empty and expires immediately. Node's exact headers remain in the fixture, and `--nocapture` prints both implementations' exact headers. No live session issuance attributes are normalized by this test.

Both runners close their servers and databases and remove disposable data. The seed credential is public test data.

To reproduce the mutation check, back up `node.json`. In the case named `logout`, temporarily change `expected.body.ok` from `true` to `false`. Run the focused Rust command above and expect an assertion failure naming `transition logout`. Restore the original fixture, then run these commands from the repository root. Both must pass:

```sh
node fixtures/parity/auth-session/generate.mjs --check
(cd rust && cargo test -p pp-api --features desktop_rebuild --test auth_session_parity -- --nocapture)
```
