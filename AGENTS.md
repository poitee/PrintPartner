# Working on Print Partner

Print Partner plans and tracks layered STL kit builds for one user. The backend is moving from Node to one Rust core, served to a Tauri 2 desktop window and a headless Docker image. The React UI stays. Read [Architecture](docs/architecture.md) for the target, the current state, and the crate map.

## Repository map

| Path | What it is |
| --- | --- |
| `rust/crates/pp-*` | Rust workspace. `pp-server` is the gateway/headless binary, `pp-desktop` the Tauri app; the rest are libraries. |
| `web/apps/web` | Shared React UI (Vite). Desktop, Docker, and browsers all load it. |
| `web/apps/server` | Node compatibility server. Rust is replacing it; maintain it, don't grow it. |
| `web/packages` | Shared TypeScript contracts and domain code. |
| `slicer-sidecar` | Legacy Python slicer integration. Change only to maintain it. |
| `docs/` | Product, architecture, and development docs. Update them in the same PR as the change. |

## Setup and checks

Toolchains: Rust from `rust-toolchain.toml` (1.99), Node 24.21 for native assets and runtime, and Node 22.23.3 only for the schema-parity oracle (`PP_SCHEMA_PARITY_NODE`). Keep both Node versions; reinstall npm dependencies after switching.

```sh
npm --prefix web ci
npm --prefix web run lint
npm --prefix web run typecheck
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
just ci            # canonical local CI; same as python3 scripts/local-ci.py
just ci --list     # step ids for --only / --skip
just guidance      # checks this file and the repo skills
```

`just ci` exits 0 with SKIP lines when a tool is missing. A SKIP is not a pass: list it under Evidence. The [CI guide](docs/development/ci.md) maps each hosted check to a local command.

## Rules

- Desktop rebuild work stays behind the default-off Cargo feature `desktop_rebuild` and the runtime switch `PP_DESKTOP_REBUILD=1` or `true`. See [Desktop rebuild flag](docs/desktop-rebuild.md). Never turn it on by default.
- One runtime owns each whole operation: routes, workers, tables, and files. No dual writes, shadow printer sends, or fallback from Rust to Node for mutations.
- Keep SQLite formats, history, immutable Plan/Plate/Required-unit IDs, autosave, and restart recovery intact.
- Printer sends need an explicit user action. Never send a real print to test something. Reconcile uncertain results instead of retrying.
- Sharing stays off by default, and MCP always requires authentication, even on loopback. See [Network sharing](docs/network-sharing.md).
- No product analytics, default-on telemetry, multi-user, SaaS, or Postgres work. Sentry stays opt-in.
- Use disposable data and loopback ports for testing. Keep tokens, cookies, pairing secrets, and customer files out of commits, logs, screenshots, and PRs.
- Don't hand-edit generated manifests or schema fixtures; run their generators.

## Pull requests

Follow the [definition of done](docs/development/definition-of-done.md):

- One job per PR, under about 1,500 changed lines. Use `Refs GRE-xxx` for partial work and `Fixes GRE-xxx` only when the ticket is done.
- Put what you ran and saw under `## Evidence`. For changes to the web UI or desktop app, attach a screenshot or video; the `pp-verify` skill shows how. The rules are in [Gate evidence](docs/contributing/gate-evidence.md).
- Factory Droid reviews every ready PR. Fix each finding, or reply with why it doesn't apply, then resolve the thread. Merging needs green required checks and no open threads.
- Run the `unslop` skill on docs, comments, and PR text. Use the `grilling` skill to stress-test a plan before large or risky work.

Repo skills live in `.factory/skills/`: [pp-verify](.factory/skills/pp-verify/SKILL.md) for screenshots and video, and [pp-readiness](.factory/skills/pp-readiness/SKILL.md) for agent-readiness work.

For local and cloud Missions, follow [Factory setup](docs/development/factory-missions.md).
Use [pp-mission-qa](.factory/skills/pp-mission-qa/SKILL.md) for runtime launch,
logs, driving, and cleanup. Keep scrutiny and user testing enabled. The project
guard hook blocks common maintainer-only actions, but does not replace review.
