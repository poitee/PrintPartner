# GRE-795: serve bounded job lists

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/api/v1/jobs` mount only when the stored `PP_DESKTOP_REBUILD` value is exactly
`1` or `true`. Otherwise those routes answer 404. Read-one aliases are GRE-796
(`docs/gre-796-jobs-http.md`). Job WebSocket admission is GRE-798
(`docs/gre-798-jobs-http.md`). Plan HTTP remains as in GRE-791–GRE-794.

Admission matches GRE-791 (loopback Host/Origin, session cookie or API key with
the configured tenant) through the shared `loopback` module. Each admitted
request runs `AtomicJobClient::list_retained` with a `LegacyListFilter` built
from the Node query fields `status`, `since` (RFC3339 → millis; invalid values
are ignored), and `profile_id` (ECMAScript `Number`-compatible scalars;
unknown or duplicate values become a no-match filter). Success is `200`
`{ "jobs": [ <JobSnapshot>, ... ] }` newest first. HEAD shares status and auth
with GET and returns an empty body. Unauthenticated requests answer `401`
`Authentication required`. Another tenant's session sees an empty list; rows and
files stay unchanged on refusal.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor-gre-795
export CARGO_BUILD_JOBS=2
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test jobs_http jobs_list_
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test jobs_http \
  jobs_list_
```
