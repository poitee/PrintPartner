# GRE-791: gated Plan list and detail reads

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/plans` and `/plans/{id}` mount at the root, `/api/v1`, and `/api/v2` only when
the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those
routes answer 404 and do not open the build graph. Create, delete, layers,
touch, jobs, and kit/builder manifests stay unregistered (later D25 children).
The desktop gateway does not mount this router in this slice.

List responses are `{ "profiles": [ <ProfileSummary>, ... ] }`. Detail
responses are a bare `ProfileSummary` (`id`, `name`, `order_number`,
`special_request`, `part_count`, `accepted_progress`, `build_stale`,
`freshness`, `archived_at`, `last_used_at`). Missing or cross-tenant ids answer
404 with `"Profile not found"`. Unauthenticated requests answer 401 with
`"Authentication required"`. HEAD shares status and auth with GET and returns
an empty body.

The session cookie or one API key selects the tenant. API keys use the
configured tenant, not a request header.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor/gre-791-build-reads
export CARGO_BUILD_JOBS=2

cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test builds_http \
  build_reads_flag_off_are_404 build_reads_are_authenticated_and_tenant_scoped
```
