# Source delete HTTP

With the default-off `desktop_rebuild` feature compiled, `DELETE /sources/{id}` is mounted at the root and `/api/v1` only when the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise the route answers 404 and does not open the catalog. Sync and upload stay unregistered. The desktop gateway does not mount this router.

A deleted Source answers 204 with an empty body. The catalog row is removed. Files already in its workspace stay on disk. A missing or non-canonical id answers 404 `Source not found`.

The catalog command's refusals are mapped exactly:

| Outcome | Status | Detail |
| --- | --- | --- |
| Active work | 409 | Source has active work and cannot be deleted |
| Immutable revisions | 409 | Source has immutable revision history and cannot be deleted |
| Another reference | 409 | Source is referenced and cannot be deleted |

Active work is checked before revision history. A refusal leaves the Source, its revisions, the referencing rows, and the held work lease unchanged.

`docs/desktop-rebuild.md` still says delete stays unregistered. That file is left unchanged while open PR #999 owns it.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http
```
