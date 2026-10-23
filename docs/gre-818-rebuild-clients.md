# GRE-818: compose rebuild HTTP clients without mounting

With the default-off `desktop_rebuild` feature compiled,
`pp_core::rebuild_api::clients` returns a `RebuildHttpClients` bundle
(auth, drafts, builds, catalog) only when the stored `PP_DESKTOP_REBUILD`
value is exactly `1` or `true`. Otherwise it returns `None` before opening
any client. `RebuildHttpClients::close` drops those handles; `WriterOwner`
still owns storage shutdown. No HTTP routes are registered in this slice
(GRE-819 mounts authenticated reads).

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor-gre-818-compose-rebuild-clients-e64c
export CARGO_BUILD_JOBS=2

cargo check -p pp-core --locked --manifest-path rust/Cargo.toml --no-default-features
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild \
  --lib application_host_flag_off_constructs_no_rebuild_clients \
  -- --exact --test-threads=2
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild \
  --lib application_host_closes_owned_clients \
  -- --exact --test-threads=2
```
