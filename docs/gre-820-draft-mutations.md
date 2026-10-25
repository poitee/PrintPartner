# GRE-820: compose draft mutation routes

With the default-off `desktop_rebuild` feature compiled,
`pp_core::rebuild_api::draft_router` mounts the completed pp-api draft
list/read/edit/abandon router when the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. Otherwise it returns `None` before opening clients or
registering routes. Root and `/api/v2` aliases share one
`WorkingDraftClient` executor from the GRE-818 bundle. Unknown draft owner
names fail closed via `RebuildDraftOwner::admit`. Rust refusals keep Node out
of the disposable loopback fixture. Production ownership cutover stays with
GRE-593.

```sh
cargo check -p pp-core --locked --manifest-path rust/Cargo.toml --no-default-features
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild \
  --test rebuild_draft_http -- --exact --test-threads=2
```

Focused tests: `draft_aliases_and_workers_share_executor`,
`rust_draft_failure_never_falls_back_to_node`.
