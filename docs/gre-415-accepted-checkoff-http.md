# GRE-415: read Accepted Plan Checkoff over HTTP

With the default-off `desktop_rebuild` feature compiled, `GET` and `HEAD`
`/plans/{id}/checkoff` mount at `/`, `/api/v1`, and `/api/v2` only when stored
`PP_DESKTOP_REBUILD` is exactly `1` or `true`. Otherwise they answer 404.
`pp_core::rebuild_api::read_router` mounts them beside the Build and catalog
reads, from the same `WriterOwner`.

Admission matches GRE-791. Each request runs one `ReadClient` batch, so the
Accepted Plan revision, Required-unit membership and progress come from one
read transaction. `read_model::views::checkoff` projects the body Node's
`toAcceptedCheckoffView` sends. The read writes nothing, and a corrupt graph is
not repaired.

| Accepted read | Response |
| --- | --- |
| Ready or empty | `200` `{profile_id, summary, parts}` |
| Missing, cross-tenant, or an id that cannot name a Plan | `404` `Profile not found` |
| Compatibility dirty | `409` `Accepted Plan requires compatibility repair` |
| Uninitialized | `409` `Accepted Plan operational state is not initialized` |
| Integrity failure | `500` `Accepted Plan data is inconsistent` |
| Bad or missing credential | `401` `Authentication required` |
| Writer queue full or storage stopped | `503` `Service temporarily unavailable` |
| Anything else | `500` `Internal Server Error` |

Filament labels come from the colour catalog only. Configured Spoolman
enrichment, Review, Build Workflow and `/parts/{id}/assembled` are not part of
this surface yet.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-api -p pp-core \
  --features pp-api/desktop_rebuild,pp-core/desktop_rebuild \
  -E 'test(ticket_t_61_read_model) | binary(rebuild_read_http)'
```
