# GRE-792: Plan create and delete

With the default-off `desktop_rebuild` feature compiled, `POST /plans` and
`DELETE /plans/{id}` mount at the root, `/api/v1`, and `/api/v2` only when the
stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those
routes answer 404. List/detail reads remain as in GRE-791. Layer list and touch
land in GRE-793. Kit-manifest ReadKit is GRE-801
(`docs/gre-801-manifest-http.md`). Layer mutate is
`docs/gre-794-builds-http.md`. Job list is `docs/gre-795-jobs-http.md`. SaveKit
and ReadBuilder stay unregistered (later D25 children).

Admission matches GRE-791 (loopback Host/Origin, session cookie or API key with
the configured tenant).

## Create (`POST /plans`)

Request body is the validated `CreateBuildRequest` DTO (`name`, optional
`base_project_id`). Names trim like Node and refuse empty or over-long values.

Success is `200` with a Node-compatible `ProfileSummary` plus a `layers` array
(empty when no base source). Refusals:

| Condition | Status | Detail |
| --- | --- | --- |
| Duplicate name | 400 | `Profile already exists: {name}` |
| Unknown base source | 400 | `Project not found` |
| Invalid / empty name body | 400 | `Profile name is required` / `Profile name is too long` / `Request is invalid` |
| Unauthenticated | 401 | `Authentication required` |

## Delete (`DELETE /plans/{id}`)

Success is `204` with an empty body. Missing or cross-tenant ids answer `404`
`Profile not found` and leave rows and files unchanged. Unauthenticated and
admission refusals likewise leave Plan state unchanged.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/cursor/gre-792-create-delete-builds
export CARGO_BUILD_JOBS=2

cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --no-default-features
cargo check -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --tests
cargo test -p pp-api --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --test builds_http \
  build_create_matches_node_contract build_delete_refusal_preserves_plan
```
