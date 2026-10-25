# Source category settings HTTP

With the default-off `desktop_rebuild` feature compiled, `GET` and `PUT`
`/settings/source-categories` are mounted at the root and `/api/v1` only when
the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. Otherwise those
routes answer 404 and do not open the catalog. Naming and location settings stay
unregistered. The desktop gateway does not mount this router.

Both methods use the wrapped catalog contract `{ "categories": [...], "tree": [...] }`
from `GetCategoriesWithTree` and `SaveCategoriesWithTree`. The unwrapped
list-only `GetCategories` / `SaveCategories` commands are not exposed on this
router. `PUT` takes Node's body shape: `categories` defaults to `[]`,
`replacements` defaults to `{}`, each category is a string, and each replacement
value is a string or null. Catalog input refusals answer 400 with the existing
detail and leave stored settings unchanged.

The session cookie or one API key selects the tenant. API keys use the
configured tenant, not a request header. Category settings are per tenant; one
tenant's save does not change another tenant's row.

`docs/desktop-rebuild.md` still describes earlier D30 slices. That file is left
unchanged while another open PR owns it.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --test catalog_http
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test catalog_http
```
