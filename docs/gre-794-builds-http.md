# GRE-794: mutate Build layers

With the default-off `desktop_rebuild` feature compiled, layer mutation routes
mount at `/`, `/api/v1`, and `/api/v2` only when stored `PP_DESKTOP_REBUILD` is
exactly `1` or `true`. Otherwise they answer 404. Prior Plan routes stay as in
GRE-791–GRE-793; kit-manifest ReadKit is GRE-801 and SaveKit is GRE-802. Job
list HTTP is `docs/gre-795-jobs-http.md`. ReadBuilder stays unregistered.

Admission matches GRE-791. Each request runs one existing `BuildGraphClient`
command in the writer transaction. Bodies use `SourceAttachmentRequest`
(`{"project_id": <positive id>}`).

| Method | Path | Command | Success |
| --- | --- | --- | --- |
| `PUT` | `/plans/{id}/layers/base` | `SetBase` | `200` `{profile_id, layers}` |
| `POST` | `/plans/{id}/layers` | `AttachAddon` | `200` `{profile_id, layers}` |
| `PUT` | `/plans/{id}/layers/{layer_id}` | `ReplaceAttachment` | `200` `{profile_id, layers}` |
| `DELETE` | `/plans/{id}/layers/{layer_id}` | `Detach` | `204` |

Refusals leave Plan rows and files unchanged: missing/cross-tenant plan → `404`
`Profile not found`; unknown source → `404` `Project not found`; unknown layer →
`404` `Layer not found`; duplicate addon attach → `409` with
`Source "{name}" is already attached to this build`; duplicate on base/replace →
`404` with the same detail; unauthenticated → `401` `Authentication required`.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor/gre-794-mutate-layers-f26b
export CARGO_BUILD_JOBS=2
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test builds_http \
  build_layer_mutations_are_atomic build_layer_wrong_owner_has_no_effects
```
