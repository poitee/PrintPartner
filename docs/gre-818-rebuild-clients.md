# GRE-818: compose rebuild HTTP clients without mounting

With the default-off `desktop_rebuild` feature compiled,
`pp_core::rebuild_api::clients` returns a `RebuildHttpClients` bundle
(auth, drafts, builds) only when the stored `PP_DESKTOP_REBUILD`
value is exactly `1` or `true`. Otherwise it returns `None` before opening
any client. Catalog is omitted: `admit_catalog_routes` takes the shared
`WriterOwner` and creates a credentialed catalog client per request
(GRE-819). `RebuildHttpClients::close` drops the owned handles; `WriterOwner`
still owns storage shutdown. No HTTP routes are registered in this slice.

```sh
cargo check -p pp-core --locked --manifest-path rust/Cargo.toml --no-default-features
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild \
  --lib application_host_flag_off_constructs_no_rebuild_clients \
  -- --exact --test-threads=2
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild \
  --lib application_host_closes_owned_clients \
  -- --exact --test-threads=2
```
