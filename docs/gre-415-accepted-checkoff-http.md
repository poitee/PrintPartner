# GRE-415: read Accepted Plan Checkoff and Part assembled units over HTTP

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
| An included Part names a custom or Spoolman filament | `503` `filament_lookup_unavailable` |
| Compatibility dirty | `409` `Accepted Plan requires compatibility repair` |
| Uninitialized | `409` `Accepted Plan operational state is not initialized` |
| Integrity failure | `500` `Accepted Plan data is inconsistent` |
| Bad or missing credential | `401` `Authentication required` |
| Writer queue full or storage stopped | `503` `Service temporarily unavailable` |
| Anything else | `500` `Internal Server Error` |

The id is read with JavaScript `Number()` rules, as Node reads it, so `1.0`,
`1e0`, `0x1` and ` 1 ` all name Plan 1.

Filament labels come from the colour catalog only. Node also reads custom
filaments from the data dir and Spoolman filaments over the network. Rust has
neither reader yet, so a Plan whose included Parts name any filament id outside
the catalog answers `503` instead of labels that may differ from Node's. That
includes ids Node also leaves blank (deleted custom filaments, Spoolman turned
off or unreachable). Review and Build Workflow are not served yet.

## Part assembled units

`GET` and `HEAD` `/parts/{id}/assembled` mount at `/` and `/api/v1` only, as
in Node, which has no `/api/v2` Part routes. `ReadClient::read_part` finds the
caller's tenant's projection Part and reads the Plan that owns it, both in one
read transaction. The body is `views::assembled`:
`{part_id, assembled_count, assembled_units}`. Excluded Parts are found too, as
in Node.

A missing Part, another tenant's Part, an empty Plan, and an id that cannot
name a Part all answer `404` `Part not found`. The 409, 500, 401 and 503 rows
above apply unchanged. The filament refusal does not apply, because the body
has no filament fields.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-api -p pp-core \
  --features pp-api/desktop_rebuild,pp-core/desktop_rebuild \
  -E 'test(ticket_t_61_read_model) | binary(rebuild_read_http)'
```
