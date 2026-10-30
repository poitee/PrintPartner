# GRE-511: no lost or repeated job stream events

`/ws/jobs/{id}` (GRE-799) reads the job snapshot and registers the
subscriber in one storage writer command. The single writer thread runs
that command to the end before it takes the next one. So no commit can land
between the snapshot read and the subscribe. The subscriber also records the
snapshot version and drops any published snapshot at or below it, so a
commit already in the snapshot is not sent again.

`job_ws_subscribe_during_commits_loses_and_repeats_nothing` in
`rust/crates/pp-api/tests/jobs_http.rs` proves this over HTTP. One socket
opens before the claim and records every frame. Ten more sockets upgrade
while a worker commits the claim, progress 1 through 12, and the finish.
Each later socket must receive an exact suffix of the first socket's frames,
ending in the one `done` frame and close 1000. A socket opened after the
finish receives only the final snapshot, then close 1000. Reconnect after a
lagged close is `job_ws_reconnect_returns_authoritative_snapshot` (GRE-800).

The verify helper's default `--repo` half of this ticket merged in #278.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-511-job-stream
export CARGO_BUILD_JOBS=2
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_subscribe_during_commits
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_subscribe_during_commits
```

With the feature off, the filter runs 1 test, the 404 stub. With the feature
on, it runs 1 test.
