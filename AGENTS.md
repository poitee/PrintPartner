# Working on Print Partner

## Read first

- [Architecture](docs/architecture.md) describes current code and the Rust target.
- [Missions readiness](docs/development/missions-readiness.md) records source precedence, migration gates, and unresolved decisions. Target acceptance is not delivered functionality.
- Follow the [definition of done](docs/development/definition-of-done.md) and [CI guide](docs/development/ci.md). The October 29 `pp/score-verified` merge requirement takes precedence over older reviewer-fallback wording.
- For a readiness assessment or QA plan, use the repository's [pp-readiness skill](.factory/skills/pp-readiness/SKILL.md) and [QA runbook](docs/development/mission-qa.md).

## Repository map

| Path | Role |
|------|------|
| `rust/crates/pp-core` and other library crates | Rust domain, storage, contracts, and infrastructure; see the architecture crate map. |
| `rust/crates/pp-server` | Rust gateway/headless executable; compatibility workers can still delegate to Node. |
| `rust/crates/pp-desktop` | Tauri 2 desktop executable, using the React webview. |
| `web/apps/web` | Shared React UI. This is not a native Rust UI rewrite. |
| `web/apps/server` | Node compatibility application being replaced, not permission to add SaaS or Postgres scope. |
| `slicer-sidecar` | Legacy slicer integration. The Rust product uses external slicing; do not expand this just to improve a readiness score. |

## Setup and checks

Run commands from the checkout root. Check the pins in `rust-toolchain.toml`, `rust/README.md`, and the CI guide before installing tools.

- Rust: the pinned toolchain, currently **1.99**.
- Native runtime/asset builds: **Node 24.21**. The transitional web engine/CI uses Node 22; the schema-parity oracle specifically requires **22.23.3**, selected with `PP_SCHEMA_PARITY_NODE`. Do not flatten these into one version. Reinstall/rebuild native npm dependencies after changing Node ABI.
- Python helpers: `python3`. Do not assume `pip`, `ensurepip`, pytest, a browser, Docker, or native SDKs are installed.

```sh
# Install web dependencies for the selected Node version.
npm --prefix web ci

# Web changes: lint and type-check; select tests for the affected area.
npm --prefix web run lint
npm --prefix web run typecheck

# Rust formatting and the canonical local CI plan.
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
python3 scripts/local-ci.py --list

# Fast offline instruction validation (also available as just guidance).
python3 -B scripts/check-agent-guidance.py
```

Run focused tests while editing, then `just ci` before pushing (`python3 scripts/local-ci.py` if `just` is unavailable). Use `--only`/`--skip` IDs from `--list` for bounded runs and disclose every omission. An exit code of zero with SKIPs is **not** all-green verification. Local Rust CI does not cover all web, contract, native desktop, Docker, signing, or release checks.

Use the QA runbook for runtime proofs. Compilation, test collection, a zero-test selector, and browser-only testing are different evidence from executed tests and installed native acceptance. Record exact HEAD, dirty state, flags, tool versions, executed counts, exit codes, and blockers.

## Migration and safety

- Work from current main in a task worktree. Preserve existing dirty files and retained reference branches/PRs. Keep one job per PR, normally under 1,500 changed lines.
- New GRE-595 desktop slices stay behind the default-off Cargo `desktop_rebuild` feature **and** runtime `PP_DESKTOP_REBUILD=1` or `true`. Do not broaden accepted values or enable defaults as a readiness fix.
- One runtime owns each whole operation, including aliases, dispatch, workers, tables, and files. No dual writes, shadow printer sends, or mutation fallback to Node. A merged library is not runtime cutover.
- Preserve immutable Plan/Plate/Required-unit identities, ordinary Plan autosave, SQLite/history formats, durable receipts, and restart recovery. Use standard OS advisory locks and existing storage mechanisms.
- Printer sends require an explicit user action. Reconcile uncertain external effects; never retry blindly. Monitoring must not change Checkoff.
- Keep sharing off and MCP authenticated, including loopback. The October 29 service-client/scoped-AI design is a target gate, not authorization to implement it in unrelated work.
- Do not add in-app AI, in-app slicing, tenants, analytics, or default-on telemetry. Sentry remains explicit opt-in. Farm/order/West3D features and the full UI redesign follow parity.
- Use disposable local data and loopback listeners for QA. Keep bootstrap URLs, cookies, pairing secrets, API keys, customer files, and private screenshots out of commits and reports. Never weaken permissions to make a fixture work.
- Do not hand-edit generated bundle manifests or schema fixtures; use their documented generators.

## Review and reporting

P0/P1 findings block. P2 data-loss, security, and normal-path crashes need fixes; polish belongs in GRE-974 or a PR comment, not new follow-up tickets. Never quarantine core no-data-loss/no-orphan tests. Use `Refs GRE-xxx` for partial work and `Fixes` only for completion.

Require exact-head independent cross-vendor review and green applicable CI before merge, including `pp/score-verified`; do not substitute self-review or waive gates. After the initial review and two fix rounds, escalate rather than loop indefinitely.

Report changes, checks actually run, skips/timeouts, and remaining gates. Do not raise a saved readiness score for plans or unmerged guidance. Do not post to Linear/Notion/GitHub, change protection or workflows, publish artifacts, or commit/push unless the user authorizes that action.
