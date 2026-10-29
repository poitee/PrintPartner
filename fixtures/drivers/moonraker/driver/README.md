# Moonraker driver fixtures (T-21, GRE-360)

Simulator bodies shaped after Moonraker's documented HTTP responses. They are
not hardware captures.

- `routes.json` maps each request target to a body; unlisted requests get 404.
  `{ORIGIN}` in a body becomes the simulator origin.
  `directory-far-future.json` holds a timestamp past the ECMAScript date limit,
  which fails the whole listing on both sides.
- `node-oracle.json` is what the Node adapter returns, plus every request it
  sends, for the `recorded`, `http-500` and `http-404` scenarios.
- `bases.json` lists base URLs that fail before any request.
  `node-oracle-bases.json` holds the Node result of every read call for each.

`web/apps/server/src/integrations/adapters/moonraker.driver-oracle.test.ts`
checks that the Node adapter still produces the oracle files. Web CI runs it
when `web/` or `fixtures/` change. `rust/crates/pp-drivers/tests/ticket_t_21_moonraker_driver.rs`
checks the Rust driver against the same files. To rewrite the oracle after a
deliberate Node change:

```sh
(cd web && UPDATE_MOONRAKER_ORACLE=1 npm run test -w @print-partner/server -- src/integrations/adapters/moonraker.driver-oracle.test.ts)
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-drivers --no-tests=fail -E 'test(ticket_t_21)'
```
