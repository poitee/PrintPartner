# Moonraker driver read fixtures (T-21, GRE-360)

Simulator bodies shaped after Moonraker's documented HTTP responses. They are
not hardware captures. `objects-query.json` is a copy of
`fixtures/drivers/moonraker/moonraker-success.json`.

- `routes.json` maps each request target to a body; unlisted requests get 404.
  `{ORIGIN}` in a body becomes the simulator origin.
- `node-oracle.json` is what the Node adapter returns, plus every request it
  sends, for the `recorded`, `http-500` and `http-404` scenarios.
  `capture-node-oracle.mts` writes it; rerun it when either side changes:

```sh
(cd web/apps/server && npx tsx ../../../rust/crates/pp-drivers/tests/fixtures/moonraker/capture-node-oracle.mts)
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-drivers --no-tests=fail -E 'test(ticket_t_21)'
```
