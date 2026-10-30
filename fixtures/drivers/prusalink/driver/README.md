# PrusaLink driver fixtures (T-22, GRE-361)

- `digest-vectors.json` lists Digest challenges and requests: header, username,
  password, method, URI, nonce count and a fixed client nonce.
- `node-oracle-digest.json` is what `web/apps/server/src/integrations/digest-auth.ts`
  returns for each vector: the parsed challenge, then the `Authorization` value
  or the error message. The first vector is the RFC 2617 section 3.5 example.
- `digest-401-stale.json` is a 401 with `stale=true` and a new nonce. The Rust
  simulator sends it when a request uses a nonce the printer no longer accepts.

- `routes.json` maps request paths to the fixtures below for authorized requests.
  An unauthorized request gets `../digest-401.json`; an unlisted path gets 404.
  It also lists the browse paths and the two configs (`auto` resolves the
  storage root from `/api/v1/storage`; `pinned` sets `storage: /local/`).
- `storage.json`, `folder-usb.json`, `folder-sub.json` and
  `folder-far-future.json` are storage and directory replies, including unsafe
  names, missing sizes, negative and zero timestamps, and a timestamp past the
  ECMAScript date limit, which fails the whole listing on both sides.
- `cameras.json` mixes connected, disconnected, unnamed and malformed cameras.
- `job-objects.json` and `print-file.gcode` drive `object_list`. The G-code
  holds bytes 0xE9 and 0x80, which Node's `TextDecoder("latin1")` reads as
  windows-1252.
- `node-oracle-reads.json` holds the Node result for cameras, `object_list` and
  each browse path, plus every request line, for the `recorded`, `pinned`,
  `no-password`, `http-500` and `http-404` scenarios.

The other recorded responses are one level up. They stay there so the Node
fixture test's seven-file inventory does not change.

`web/apps/server/src/integrations/digest-auth.oracle.test.ts` and
`web/apps/server/src/integrations/adapters/prusalink.driver-oracle.test.ts` check
that Node still produces the oracles. `rust/crates/pp-drivers/tests/ticket_t_22_prusalink.rs`
and `ticket_t_22_prusalink_reads.rs` check the Rust driver against the same files. To rewrite the oracle after a
deliberate Node change:

```sh
(cd web && UPDATE_PRUSALINK_ORACLE=1 npm run test -w @print-partner/server -- src/integrations/digest-auth.oracle.test.ts src/integrations/adapters/prusalink.driver-oracle.test.ts)
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_22)'
```
