# GRE-799: stream authoritative job snapshots

With the default-off `desktop_rebuild` feature compiled, `GET /ws/jobs/{id}`
still mounts only when the stored `PP_DESKTOP_REBUILD` value is exactly `1` or
`true`. Otherwise that route answers 404. Admission stays as in GRE-798
(`docs/gre-798-jobs-http.md`). `HEAD` still does not subscribe.

A missing id and another tenant's job upgrade, send no snapshot, and close
with code 1008 and reason `Job not found`. `HEAD` for those callers stays
`404` `"Job not found"`.

An admitted socket sends the same public snapshot as read-one, including the
job already queued at subscribe. Later commits on that job are sent the same
way. A `done`, `error`, or `cancelled` snapshot is the last frame, then the
socket closes with code 1000. Logout revokes the stream: the socket closes
with code 1008 and reason `Session revoked`, and no further snapshot is sent.
A session that reaches its expiry while the socket is open closes with code
1008 and reason `Session expired`. A new upgrade whose session is already
expired stays HTTP 401, the same as read-one. A lagged mailbox or a stopped
jobs service closes with code 1011 and reason `Job stream unavailable`.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-799-job-ws
export CARGO_BUILD_JOBS=2
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_delivers_initial_and_terminal_snapshot
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_revocation_closes_without_further_data
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_delivers_initial_and_terminal_snapshot
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_revocation_closes_without_further_data
```

With the feature off, each filter runs 1 test, the 404 stub. With the feature
on, each filter runs 1 test.
