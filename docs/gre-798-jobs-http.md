# GRE-798: authenticate job WebSocket upgrades

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/ws/jobs/{id}` mount only when the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. Otherwise that route answers 404. List and read-one
stay as in GRE-795 and GRE-796. Mutation routes stay unregistered. Snapshot
frames on the socket are GRE-799.

Admission matches GRE-796 (loopback Host and Origin, one session cookie or
API key for the configured tenant) through the shared `loopback` module.
A wrong listener answers `403` `"Invalid request host"`. A wrong origin
answers `403` `"Invalid request origin"`. A missing credential answers `401`
`"Authentication required"`. Those refusals happen in the guard, before
`subscribe`.

An admitted upgrade calls `read_public` first. An expired session, a key the
configured tenant does not own, a missing id, and another tenant's job fail
there and do not call `subscribe`. The status matches read-one: `401`
`"Authentication required"` or `404` `"Job not found"`. That HTTP 404 matches
read-one. Node's `/ws/jobs/:jobId` accepts the socket and then closes with
code 1008 and reason `Job not found`
(`web/apps/server/src/routes/jobs.ts`). The web client treats only that close
as final and reconnects on any other close
(`web/apps/web/src/api/jobWebSocket.ts`). GRE-799
(`docs/gre-799-jobs-http.md`) owns that close and the snapshot pump. This slice
does not upgrade a missing or foreign job. After `read_public` accepts the
caller, the upgrade calls `subscribe` and holds that subscription until the
socket closes. This slice sends no job snapshot.

`HEAD /ws/jobs/{id}` uses the same guard and `read_public` check. Success is
`200` with an empty body. It does not call `subscribe`, including when every
stream slot is already held. Rows stay unchanged on refusal.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-798-job-ws
export CARGO_BUILD_JOBS=2
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_rejects_invalid_origin_or_principal
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_ws_head_does_not_subscribe
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_rejects_invalid_origin_or_principal
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_ws_head_does_not_subscribe
```

With the feature off, each filter runs 1 test, the 404 stub. With the feature
on, each filter runs 1 test.
