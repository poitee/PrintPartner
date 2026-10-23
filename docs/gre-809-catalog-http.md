# Source import rules and activity HTTP

With the default-off `desktop_rebuild` feature compiled, these routes are mounted
at the root and `/api/v1` only when the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. Otherwise they answer 404 and do not open the catalog.
Global `GET`/`PUT /settings/stl-naming` stay unregistered (GRE-810). Sync,
upload, and location stay unregistered. The desktop gateway does not mount this
router.

| Method | Path | Catalog request |
| --- | --- | --- |
| GET / PUT | `/sources/{id}/import-rules` | `GetImportRules` / `SaveImportRules` |
| GET | `/sources/activity` | `SourceActivity { limit }` |

`/sources/activity` is registered before `/sources/{id}` so `"activity"` is not
parsed as a Source id. Catalog HTTP body limit is 8 MiB so storage
`IMPORT_RULE_BODY_LIMIT` remains the authority for oversize import-rule PUTs.

`PUT` takes Node's body shape `{ "rules"?: string[] }`. Missing or null `rules`
becomes `[]`; each rule uses Node `String()` coercion. Responses are storage
`Outcome::Data` JSON (`rules`, and `legacy_import_all` on get).

`GET /sources/activity` coerces `limit` like Node: `Number(query.limit ?? 20)`,
non-finite → `20`, then trunc and clamp `1..=100`. Storage returns a bare event
array; HTTP wraps `{ "events": [...] }`. Event `source_id` keeps the exact JSON
number or null from storage.

| Refusal | Status | Detail |
| --- | --- | --- |
| Non-object / non-array `rules` body | 400 | `Invalid JSON body` |
| Non-null `local_path` on PUT | 400 | `Raw local_path requires native Source selection` |
| Missing / non-canonical Source id | 404 | `Source not found` |
| Oversize import-rule body | 413 | `Catalog request too large` |

A refused write leaves Source rows, DB bytes, and `imported_paths` unchanged.
Activity is read-only.

`docs/gre-808-catalog-http.md` and `docs/desktop-rebuild.md` are left unchanged.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http \
  catalog_import_rules_round_trip catalog_activity_limit_matches_node
```
