# Record the Rust crate layout and dependency edges

Status: accepted record of the `rust/crates` layout on `main` and the planned edges as the desktop rebuild slices land on main ([GRE-595](../desktop-rebuild.md#slice-plan); the old desktop chain and #171 will not land). D3 adds the optional `pp-core` to `pp-source` and `pp-net` edges for review observations. The boundary checker requires those edges to compile through `desktop_rebuild` only.

Print Partner's Rust workspace under `rust/crates` is the protected runtime foundation and the home for the D7 crate split. Enforcement today is the explicit `ALLOWED` map in `rust/scripts/check-boundaries.py`, checked with `cargo metadata --no-deps`. Edges listed as **current** are copied from that map. Edges listed as **planned** cover the addition of `pp-api`, extensions to `pp-storage`, printer/provider adapters in the reserved `pp-drivers` crate, and broader use cases extending `pp-services` beyond its existing Orca/Bambu discovery. Planned edges are documentation only until a later change updates `ALLOWED`.

## Crates on main

As of 2026-10-13, main contains 14 workspace crates. `pp-storage` landed through PR #128 and `pp-api` (auth only) through PR #130.

| Crate | Role |
| --- | --- |
| `pp-domain` | Pure domain values and ports: bounded integers, IDs, versions, quantities, text, digests, draft state. No Tokio, SQLite, HTTP, or Tauri. |
| `pp-api-types` | Wire DTOs, constructors, validation, and parsers (autosave and related). Built on `pp-domain`. |
| `pp-contracts` | Compatibility facade: re-exports the contract surface used by parity binaries and external consumers; owns parity tooling. |
| `pp-net` | Checked outbound connection helpers (gateway target canonicalization today). |
| `pp-drivers` | Printer and provider adapters that use `pp-net` (Moonraker status today). Further printer/provider moves wait for the rebuild slices. |
| `pp-services` | Native Orca/Bambu slicer discovery. Broader use cases on domain ports remain planned; the crate has no workspace dependency. |
| `pp-storage` | SQLite owner, migrations, bounded settings writer, read-only pool, storage lease, and safe backups. Node still owns application SQL operations. |
| `pp-source` | Immutable local Source snapshot materialization and bounded ZIP extraction (filesystem bytes and manifest). Does not own SQL, catalog activation, or HTTP routes. |
| `pp-api` | Rust HTTP API surface. On main it holds the auth module only and may depend on `pp-storage`. The rebuild slices D23 to D25 add auth HTTP, drafts HTTP, and builds/jobs HTTP behind `desktop_rebuild`. |
| `pp-gateway` | Loopback listeners, session/bootstrap policy, route ownership, and proxy to the Node compatibility child. |
| `pp-compat` | Temporary Node process supervisor, release measurement, and private Unix-socket proxy. |
| `pp-core` | Composition root: storage lease, gateway and supervisor lifetimes, desktop launch wiring. |
| `pp-desktop` | Tauri window, tray, and native OS shell around `pp-core`. |
| `pp-server` | Headless launcher binary around `pp-core`. |

## Crates planned with the desktop rebuild

`pp-api` and `pp-storage` are already on main. The rebuild slices extend `pp-storage` (D6 to D22) and `pp-api` (D23 to D25) with authentication and domain operations. These planned changes retain the open questions below.

| Crate | Role |
| --- | --- |
| `pp-storage` | Extend the existing SQLite adapter with authentication, domain operations, jobs, and durable recovery. |
| `pp-api` | HTTP (and later MCP/WS) adapters that map wire DTOs onto owned operations and storage. |

## Current allowed edges

Copied from `ALLOWED` in `rust/scripts/check-boundaries.py` on `main`. A missing `pp-*` name in a set means no workspace dependency is allowed.

| Crate | Current allowed `pp-*` deps |
| --- | --- |
| `pp-source` | *(none)* |
| `pp-core` | `pp-gateway`, `pp-compat`, `pp-storage`, `pp-source` and `pp-net` only through `desktop_rebuild` |
| `pp-storage` | `pp-domain` and `pp-contracts`, only through `desktop_rebuild` |
| `pp-api` | `pp-storage` |
| `pp-gateway` | `pp-compat`, `pp-drivers`, `pp-net` |
| `pp-compat` | *(none)* |
| `pp-server` | `pp-core` |
| `pp-contracts` | `pp-api-types` |
| `pp-desktop` | `pp-core` |
| `pp-domain` | *(none)* |
| `pp-api-types` | `pp-domain` |
| `pp-net` | *(none)* |
| `pp-drivers` | `pp-net`, `pp-api-types` |
| `pp-services` | *(none)* |

Graph form of the non-empty current edges:

```text
pp-contracts → pp-api-types → pp-domain
pp-api → pp-storage
pp-gateway → pp-compat, pp-drivers, pp-net
pp-drivers → pp-net, pp-api-types
pp-core → pp-gateway, pp-compat, pp-storage
pp-core → pp-source, pp-net                 (desktop_rebuild only)
pp-storage → pp-domain, pp-contracts         (desktop_rebuild only)
pp-desktop → pp-core
pp-server → pp-core
pp-source, pp-services → (no pp-* deps)
```

## Planned edges after the desktop rebuild

Marked **planned**. Taken from the reference branch’s (`desktop/source-sync-local-current-20261008`) `ALLOWED` for `pp-storage` / `pp-api` / `pp-source` wiring, plus the design-doc moves into `pp-drivers` and `pp-services`. Current edges that remain unchanged are restated for a full picture. This is not an `ALLOWED` edit.

| Crate | Planned allowed `pp-*` deps |
| --- | --- |
| `pp-storage` | `pp-domain`, `pp-contracts` *(already current, only through `desktop_rebuild`)* |
| `pp-api` | `pp-storage` *(current)*, plus `pp-contracts` **(planned addition)** |
| `pp-core` | `pp-gateway`, `pp-compat`, `pp-storage`, `pp-source`, `pp-net` *(current, gated)*, plus `pp-api` **(planned addition)** |
| `pp-drivers` | `pp-net`, `pp-api-types` *(current; more printer/provider code moves in later)* |
| `pp-services` | `pp-domain` **(planned; use cases on domain ports only)** |
| `pp-gateway` | `pp-compat`, `pp-drivers`, `pp-net` *(unchanged)* |
| `pp-compat` | *(none)* *(unchanged)* |
| `pp-server` | `pp-core` *(unchanged)* |
| `pp-desktop` | `pp-core` *(unchanged)* |
| `pp-contracts` | `pp-api-types` *(unchanged until open question resolved)* |
| `pp-api-types` | `pp-domain` *(unchanged)* |
| `pp-domain` | *(none)* *(unchanged)* |
| `pp-net` | *(none)* *(unchanged)* |
| `pp-source` | *(none)* *(unchanged leaf; consumers gain edges to it)* |

Planned additions and already current storage edges in graph form:

```text
pp-storage → pp-domain, pp-contracts         (already current, desktop_rebuild only)
pp-api → pp-contracts                        (planned addition)
pp-core → pp-api                             (planned addition)
pp-services → pp-domain                      (planned)
```

`pp-services` must not gain edges to `pp-storage`, `pp-net`, or `pp-drivers`; `pp-core` composes those implementations. Further `pp-api` → `pp-services` wiring may appear when HTTP handlers stop calling storage directly; that edge is not claimed here.

## Open questions (owner: Chad)

These are recorded, not decided.

1. **`pp-contracts` vs `pp-api-types`.** Main keeps a facade (`pp-contracts` → `pp-api-types` → `pp-domain`). The reference branch treats `pp-contracts` as the DTO crate with no `pp-api-types` member. Decide whether both names stay (facade + types), whether one is renamed away, and which name `pp-storage` / `pp-api` should depend on when the rebuild slices land (D6, D23).
2. **Where `pp-source` belongs.** `pp-source` is already a leaf workspace crate on main (filesystem snapshot materialization). Confirm it remains a first-class crate in the D7 layout versus folding snapshot ownership into `pp-services` or `pp-storage`, and confirm the planned `pp-core` → `pp-source` edge when composition lands.

## Evidence

```sh
python3 rust/scripts/check-boundaries.py --self-test
```

```json
{"packages": 14, "allowed_edges": true, "intentional_violation_rejected": true}
```
