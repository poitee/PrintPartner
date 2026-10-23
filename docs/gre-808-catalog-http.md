# Source naming and STL naming preview HTTP

With the default-off `desktop_rebuild` feature compiled, these routes are mounted
at the root and `/api/v1` only when the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. Otherwise they answer 404 and do not open the catalog.
Global `GET`/`PUT /settings/stl-naming` stay unregistered (GRE-810). Sync,
upload, and location stay unregistered. The desktop gateway does not mount this
router.

| Method | Path | Catalog request |
| --- | --- | --- |
| GET | `/sources/{id}/naming` | `GetNaming` |
| PUT | `/sources/{id}/naming` | `SaveNaming` |
| POST | `/settings/stl-naming/preview` | `PreviewNaming` |

`PUT` takes Node's body shape: `{ "use_defaults": true }` or
`{ "use_defaults": false, "override": <full NamingProfile> }`. The HTTP fields
map to storage `NamingCommand::{UseDefaults, Override { profile }}`; the body is
not deserialized as `NamingCommand` (storage uses a `kind` tag). Successful get
and save responses are the storage `Outcome::Data` JSON projection
(`use_defaults`, `override`, `effective`, `effective_digest`).

`POST` preview takes `{ "relative_path", "profile?" }`. Missing or null
`relative_path` becomes `""`; other scalars use Node `String()` coercion.
Optional `profile` is a typed `NamingOverride`. The response is
`{ role, quantity, part_slug, filename }`.

| Refusal | Status | Detail |
| --- | --- | --- |
| Invalid override / preview input | 400 | Exact storage `CatalogFailure::Input` string (for example `Blank naming label`, `Empty roles override`, `Naming requires primary role`) |
| Missing Source on get/put | 404 | `Source not found` |
| Corrupt stored naming | 500 | `Stored Source naming settings are invalid` |

A refused write leaves Source metadata, DB bytes, and the naming projection
unchanged. Preview is read-only.

`docs/desktop-rebuild.md` and `docs/gre-807-catalog-http.md` are left unchanged
while other tips may own them. Category settings remain in
`docs/gre-807-catalog-http.md`.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http \
  catalog_naming_preview_matches_storage catalog_invalid_override_does_not_write
```
