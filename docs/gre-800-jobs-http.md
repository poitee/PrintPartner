# GRE-800: prove job socket reconnect and shutdown

With the default-off `desktop_rebuild` feature compiled, `GET /ws/jobs/{id}`
still mounts only when the stored `PP_DESKTOP_REBUILD` value is exactly `1` or
`true`. Otherwise that route answers 404. Admission and snapshot delivery stay
as in GRE-798 and GRE-799 (`docs/gre-799-jobs-http.md`).

The mailbox holds 16 snapshots. Claim publishes one. Progress 1 through 15
fills the remaining slots. Progress 16 is the 17th publish, and that publish
marks the subscription lagged. The socket closes with code 1011 and reason
`Job stream unavailable` when those 17 snapshots publish before the pump
admits another frame. The test uses a current_thread runtime so those
publishes finish before the pump runs. A later upgrade on the same job sends
the current public snapshot, with progress 16 and no `updated_at`.

Shutting down the storage owner closes every live socket on that route with
the same 1011 reason. A later upgrade is HTTP 500 `"Jobs service unavailable"`.
Job rows stay as they were.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-800-job-ws
export CARGO_BUILD_JOBS=2
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_reconnect_returns_authoritative_snapshot
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http jobs_router_shutdown_closes_subscriptions
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_reconnect_returns_authoritative_snapshot
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http jobs_router_shutdown_closes_subscriptions
```

With the feature off, each filter runs 1 test, the 404 stub. With the feature
on, each filter runs 1 test.
