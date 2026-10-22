# Source create and patch HTTP

With the default-off `desktop_rebuild` feature compiled, `POST /sources` and `PATCH /sources/{id}` are mounted at the root and `/api/v1` only when the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those routes answer 404 and do not open the catalog. Delete, sync, and upload stay unregistered. The desktop gateway does not mount this router.

Bodies use Node's `String()` coercion. Missing and null fields are omitted, except `name` on create, which becomes an empty string, and `tag` on patch, where JSON null clears the stored tag. `source_type` is ignored. Metadata is kept only when it is a JSON object; a JSON array is omitted. A non-null `local_path` is refused with 400 `Raw local_path requires native Source selection` and does not write. Source ids use the same canonical integers as catalog reads.

The session cookie or one API key selects the tenant. API keys use the configured tenant, not a request header. Patching another tenant's id returns 404 `Source not found`. The refusal leaves stored rows and files unchanged.

`docs/desktop-rebuild.md` still says create and patch stay unregistered. That file is left unchanged while another open PR owns it.

`fixtures/parity/catalog-source-http/generate.mjs` records Node's route coercion, GitHub location normalization, and category-path normalization. Regenerate it from the repository root with `node fixtures/parity/catalog-source-http/generate.mjs`, and check it with `--check`.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http
```
