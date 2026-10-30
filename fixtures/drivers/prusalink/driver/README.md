# PrusaLink driver fixtures (T-22, GRE-361)

- `digest-vectors.json` lists Digest challenges and requests: header, username,
  password, method, URI, nonce count and a fixed client nonce.
- `node-oracle-digest.json` is what `web/apps/server/src/integrations/digest-auth.ts`
  returns for each vector: the parsed challenge, then the `Authorization` value
  or the error message. The first vector is the RFC 2617 section 3.5 example.
- `digest-401-stale.json` is a 401 with `stale=true` and a new nonce. The Rust
  simulator sends it when a request uses a nonce the printer no longer accepts.

The other recorded responses are one level up. They stay there so the Node
fixture test's seven-file inventory does not change.

`web/apps/server/src/integrations/digest-auth.oracle.test.ts` checks that Node
still produces the oracle. `rust/crates/pp-drivers/tests/ticket_t_22_prusalink.rs`
checks the Rust driver against the same files. To rewrite the oracle after a
deliberate Node change:

```sh
(cd web && UPDATE_PRUSALINK_ORACLE=1 npm run test -w @print-partner/server -- src/integrations/digest-auth.oracle.test.ts)
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_22)'
```
