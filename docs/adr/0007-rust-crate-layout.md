# Record the Rust crate layout and dependency edges

Status: accepted record of the `rust/crates` layout on `main` and the planned edges when the desktop chain ([GitHub #171](https://github.com/poitee/PrintPartner/issues/171)) lands. This ADR does not change `ALLOWED` in `rust/scripts/check-boundaries.py` or any crate dependency.

Print Partner's Rust workspace under `rust/crates` is the protected runtime foundation and the home for the D7 crate split. Enforcement today is the explicit `ALLOWED` map in `rust/scripts/check-boundaries.py`, checked with `cargo metadata --no-deps`. Edges listed as **current** are copied from that map. Edges listed as **planned** are the expected allowlist after #171 brings in `pp-api` and extends `pp-storage` and after content moves into the reserved `pp-drivers` and `pp-services` crates. Planned edges are documentation only until a later change updates `ALLOWED`.

## Crates on main

As of 2026-10-12, main contains 13 workspace crates. `pp-storage` landed through PR #128.

| Crate | Role |
| --- | --- |
| `pp-domain` | Pure domain values and ports: bounded integers, IDs, versions, quantities, text, digests, draft state. No Tokio, SQLite, HTTP, or Tauri. |
| `pp-api-types` | Wire DTOs, constructors, validation, and parsers (autosave and related). Built on `pp-domain`. |
| `pp-contracts` | Compatibility facade: re-exports the contract surface used by parity binaries and external consumers; owns parity tooling. |
| `pp-net` | Checked outbound connection helpers (gateway target canonicalization today). |
| `pp-drivers` | Reserved for printer and provider adapters that use `pp-net`. Stub on main (`Move deferred until after #171`). |
| `pp-services` | Native Orca/Bambu slicer discovery. Broader use cases on domain ports remain planned; the crate has no workspace dependency. |
| `pp-storage` | SQLite owner, migrations, bounded settings writer, read-only pool, storage lease, and safe backups. Node still owns application SQL operations. |
| `pp-source` | Immutable local Source snapshot materialization and bounded ZIP extraction (filesystem bytes and manifest). Does not own SQL, catalog activation, or HTTP routes. |
| `pp-gateway` | Loopback listeners, session/bootstrap policy, route ownership, and proxy to the Node compatibility child. |
| `pp-compat` | Temporary Node process supervisor, release measurement, and private Unix-socket proxy. |
| `pp-core` | Composition root: storage lease, gateway and supervisor lifetimes, desktop launch wiring. |
| `pp-desktop` | Tauri window, tray, and native OS shell around `pp-core`. |
| `pp-server` | Headless launcher binary around `pp-core`. |

## Crates planned with #171

`pp-api` is not a workspace member on main yet. `pp-storage` is already on main; the desktop chain extends it with authentication and domain operations. These planned changes retain the open questions below.

| Crate | Role |
| --- | --- |
| `pp-storage` | Extend the existing SQLite adapter with authentication, domain operations, jobs, and durable recovery. |
| `pp-api` | HTTP (and later MCP/WS) adapters that map wire DTOs onto owned operations and storage. |

## Current allowed edges

Copied from `ALLOWED` in `rust/scripts/check-boundaries.py` on `main`. A missing `pp-*` name in a set means no workspace dependency is allowed.

| Crate | Current allowed `pp-*` deps |
| --- | --- |
| `pp-source` | *(none)* |
| `pp-core` | `pp-gateway`, `pp-compat`, `pp-storage` |
| `pp-storage` | *(none)* |
| `pp-gateway` | `pp-compat`, `pp-net` |
| `pp-compat` | *(none)* |
| `pp-server` | `pp-core` |
| `pp-contracts` | `pp-api-types` |
| `pp-desktop` | `pp-core` |
| `pp-domain` | *(none)* |
| `pp-api-types` | `pp-domain` |
| `pp-net` | *(none)* |
| `pp-drivers` | *(none)* |
| `pp-services` | *(none)* |

Graph form of the non-empty current edges:

```text
pp-contracts → pp-api-types → pp-domain
pp-gateway → pp-compat, pp-net
pp-core → pp-gateway, pp-compat, pp-storage
pp-desktop → pp-core
pp-server → pp-core
pp-source, pp-storage, pp-drivers, pp-services → (no pp-* deps)
```

## Planned edges after #171

Marked **planned**. Taken from the desktop chain’s `ALLOWED` for `pp-storage` / `pp-api` / `pp-source` wiring, plus the design-doc moves into `pp-drivers` and `pp-services`. Current edges that remain unchanged are restated for a full picture. This is not an `ALLOWED` edit.

| Crate | Planned allowed `pp-*` deps |
| --- | --- |
| `pp-storage` | `pp-contracts` **(planned dependency on the existing crate)** |
| `pp-api` | `pp-contracts`, `pp-storage` **(planned; new crate)** |
| `pp-core` | `pp-gateway`, `pp-compat`, `pp-storage`, plus `pp-api` and `pp-source` **(planned additions)** |
| `pp-drivers` | `pp-net` **(planned; printers/providers move)** |
| `pp-services` | `pp-domain` **(planned; use cases on domain ports only)** |
| `pp-gateway` | `pp-compat`, `pp-net` *(unchanged)* |
| `pp-compat` | *(none)* *(unchanged)* |
| `pp-server` | `pp-core` *(unchanged)* |
| `pp-desktop` | `pp-core` *(unchanged)* |
| `pp-contracts` | `pp-api-types` *(unchanged until open question resolved)* |
| `pp-api-types` | `pp-domain` *(unchanged)* |
| `pp-domain` | *(none)* *(unchanged)* |
| `pp-net` | *(none)* *(unchanged)* |
| `pp-source` | *(none)* *(unchanged leaf; consumers gain edges to it)* |

Planned additions in graph form:

```text
pp-storage → pp-contracts                    (planned)
pp-api → pp-contracts, pp-storage            (planned)
pp-core → pp-api, pp-source                  (planned additions)
pp-drivers → pp-net                          (planned)
pp-services → pp-domain                      (planned)
```

`pp-services` must not gain edges to `pp-storage`, `pp-net`, or `pp-drivers`; `pp-core` composes those implementations. Further `pp-api` → `pp-services` wiring may appear when HTTP handlers stop calling storage directly; that edge is not claimed here.

## Open questions (owner: Chad)

These are recorded, not decided.

1. **`pp-contracts` vs `pp-api-types`.** Main keeps a facade (`pp-contracts` → `pp-api-types` → `pp-domain`). The desktop chain treats `pp-contracts` as the DTO crate with no `pp-api-types` member. Decide whether both names stay (facade + types), whether one is renamed away, and which name `pp-storage` / `pp-api` should depend on when the chain lands.
2. **Where `pp-source` belongs.** `pp-source` is already a leaf workspace crate on main (filesystem snapshot materialization). Confirm it remains a first-class crate in the D7 layout versus folding snapshot ownership into `pp-services` or `pp-storage`, and confirm the planned `pp-core` → `pp-source` edge when composition lands.

## Evidence

```sh
python3 rust/scripts/check-boundaries.py --self-test
```

```json
{"packages": 13, "allowed_edges": true, "intentional_violation_rejected": true}
```
