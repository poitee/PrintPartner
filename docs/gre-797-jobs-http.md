# GRE-797: bound retained job responses

With the default-off `desktop_rebuild` feature compiled, job list and read-one
keep the GRE-795 and GRE-796 routes. Those routes still mount only when the
stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise they
answer 404. Mutation routes and `/ws/jobs/{id}` stay unregistered.

Each admitted list or read-one takes one of two serializer permits before it
reads storage or encodes JSON. A missing job or an encode failure drops that
permit before the error JSON returns. A request with no session is refused in
the guard before a serializer permit is taken. A successful body keeps the
permit until hyper finishes that body or drops it.
A third overlapping serialization answers `503` `"Jobs service temporarily
unavailable"`. Rows and files stay unchanged on refusal.

Read-one JSON is the public snapshot. It includes `job_id`, `kind`, `status`,
`message`, `progress`, `result`, `error`, `created_at`, and `finished_at`. It
omits `updated_at`. The list at `/api/v1/jobs` still wraps the same snapshots
and keeps `updated_at` on each job. The completed `result` is the stored public
result in both responses.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-797-retained-job
export CARGO_BUILD_JOBS=2
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http job_response_refusal_releases_permit
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http retained_job_response_preserves_public_json
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --lib retained_body_drop_releases_permit
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http job_response_refusal_releases_permit
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http retained_job_response_preserves_public_json
```

With the feature off, each of the two `jobs_http` filters runs 1 test, the
404 stub. The permit unit test compiles only with `desktop_rebuild`. With the
feature on, that test reports 1 passed, and each `jobs_http` filter reports 1
passed.
