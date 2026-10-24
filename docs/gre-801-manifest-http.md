# GRE-801: gated kit-manifest ReadKit HTTP

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/plans/{id}/kit-manifest` mount at the root, `/api/v1`, and `/api/v2` only when
the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those
routes answer 404 and do not open the build graph. SaveKit (`PUT`) is GRE-802
(`docs/gre-802-manifest-http.md`). Plan-manifest-builder ReadBuilder is GRE-803
(`docs/gre-803-manifest-http.md`). The desktop gateway does not mount this
router in this slice.

Admission (loopback Host/Origin, principal, forwarded-header refusal) is shared
with Plan list/detail through the Build router (`docs/gre-791-builds-http.md`).

Successful responses are storage `ManifestOptionsOutcome::Kit` JSON via
`into_success_body()`: `{ "profile_id": <id>, "kit": <KitManifest> }`. Missing
or cross-tenant ids answer 404 with `"Profile not found"`. Unauthenticated
requests answer 401 with `"Authentication required"`. HEAD shares status and
auth with GET and returns an empty body. Absent or malformed stored kits read
as the empty kit, matching storage ReadKit.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-801-kit-manifest-read-cb26
export CARGO_BUILD_JOBS=2

cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --test manifest_options_http
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test manifest_options_http \
  kit_manifest_read_matches_storage kit_manifest_read_flag_off_is_404
```
