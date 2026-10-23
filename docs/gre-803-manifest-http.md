# GRE-803: gated plan-manifest-builder ReadBuilder HTTP

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/plans/{id}/plan-manifest-builder` mount at the root, `/api/v1`, and `/api/v2`
next to the GRE-801/GRE-802 kit-manifest routes, only when the stored
`PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those routes
answer 404 and do not open the build graph. The desktop gateway does not mount
this router in this slice.

Admission (loopback Host/Origin, principal, forwarded-header refusal) is shared
with Plan list/detail through the Build router (`docs/gre-791-builds-http.md`).

Successful responses are storage `ManifestOptionsOutcome::Builder` JSON via
`into_success_body()` (builder observation bytes, including `profile_id` and
`merged_option_groups`). Missing or cross-tenant ids answer 404 with
`"Profile not found"`. A changed capture basis that exhausts the single
ReadBuilder retry answers 409 with `stale_observation`. Source observation
failures answer 503 with `source_observation_failed`. Cancellation during
observation answers 503 with `request_cancelled`. Unauthenticated requests
answer 401 with `"Authentication required"`. HEAD shares status and auth with
GET and returns an empty body.

ReadBuilder reuses storage capture, double-observe, one retry on stamp change,
and GRE-751 zero-variant cancellation checks; this slice only registers the
HTTP route.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-803-read-builder-http-297d
export CARGO_BUILD_JOBS=2

cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test manifest_options_http
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test manifest_options_http \
  builder_read_
```

