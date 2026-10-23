# GRE-793: Plan layer list and touch

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/plans/{id}/layers` and `POST /plans/{id}/touch` mount at the root, `/api/v1`,
and `/api/v2` only when the stored `PP_DESKTOP_REBUILD` value is exactly `1` or
`true`. Otherwise those routes answer 404. List/detail/create/delete remain as
in GRE-791/GRE-792. Layer mutate (base/addon replace/detach), jobs, and
kit/builder manifests stay unregistered (later D25 children).

Admission matches GRE-791 (loopback Host/Origin, session cookie or API key with
the configured tenant).

## Layer list (`GET` / `HEAD` `/plans/{id}/layers`)

Success is `200` with
`{ "profile_id": <id>, "layers": [ <ProfileLayer>, ... ] }`. Each layer carries
`id`, `layer_order`, `layer_type`, `project_id`, and `project_name` from the
existing `BuildCommand::ListLayers` outcome. HTTP does not invent freshness or
stale/untracked reasons on this response. Missing or cross-tenant ids answer
`404` `"Profile not found"`.

## Touch (`POST` `/plans/{id}/touch`)

Success is `200` with a bare `ProfileSummary` from `BuildCommand::Touch` (same
fields as detail reads; no `layers` array). Touch updates `last_used_at` only
and leaves `config_modified_at` unchanged. Stale and untracked freshness reason
values are the domain outcomes already computed for the Build; presenters map
them through `profile_summary` without rewriting kinds. Missing or cross-tenant
ids answer `404` `"Profile not found"` and leave rows and files unchanged.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor/gre-793-read-touch-layers-6cdf
export CARGO_BUILD_JOBS=2

cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test builds_http \
  build_layer_read_preserves_stale_reasons build_touch_uses_existing_command
```
