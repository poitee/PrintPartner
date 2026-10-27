# GRE-821: compose job routes

With the default-off `desktop_rebuild` feature compiled,
`pp_core::rebuild_api::job_router` mounts the completed jobs list, read-one,
and `/ws/jobs/{id}` router when the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. Otherwise it returns `None` before opening a jobs
client. The `origin` argument is the current listener. Another host is refused
with 403 `Invalid request host` before subscribe. Owner shutdown closes a live
socket with 1011 `Job stream unavailable`. Draining tracked work stays with
GRE-448. Production gateway cutover stays with GRE-593.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-821-runtime-jobs
export CARGO_BUILD_JOBS=2
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --test rebuild_jobs_http -- --test-threads=2
cargo test -p pp-core --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test rebuild_jobs_http -- --test-threads=2
```

With the feature off, the command runs 2 empty tests. With the feature on, the
command runs 2 tests.
