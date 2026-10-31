# Print Partner Missions readiness

Decision reconciliation: **2026-10-31**. This page guides bounded migration work. It is not a release certificate or permission to enable unfinished features.

The [gap-closure roadmap](readiness-roadmap.md) maps every incomplete baseline
criterion to an implementation slice and evidence requirement.

## Authority and scope

- **Linear owns execution:** [Print Partner Desktop (Rust core)](https://linear.app/greetz/project/print-partner-desktop-rust-core-1df07fb28c16), with small replacement slices under [GRE-595](https://linear.app/greetz/issue/GRE-595).
- **Notion owns product design:** [Goals & Decisions](https://app.notion.com/p/3fa6dd30b69881bfbb89d04836541db3), [current rebuild plan](https://app.notion.com/p/3f86dd30b69881ce8ca4e5e0ea2f3c76), and the October 29 [Optional Server + AI Connector](https://app.notion.com/p/4086dd30b6988110ad42fb1d04abd5b3).
- **GitHub owns implementation:** versioned configuration, executable instructions, tests, and exact-head evidence. A ticket marked Done or a design checkbox does not prove runtime behavior.
- Newer explicit product decisions supersede older designs in the affected area. Report disagreements rather than silently editing external records. Recheck these sources before architecture changes.

The October 29 service-client and scoped-AI decisions supersede older “Docker-only headless, no service/read-only roles” wording. They are **target acceptance gates**, not proof of implementation. Pairing/listener/auth/TLS/mDNS tickets GRE-350, GRE-374, GRE-375, GRE-376, GRE-378, and GRE-379 still need alignment with that design.

The target remains one single-user Rust core, a Tauri 2 desktop shell with the shared React UI, and the headless server/Docker form. It is not an egui/Slint/Iced rewrite or a hosted multi-tenant product. Mac ships first; Windows and Linux remain required before 1.0.

## Baseline, not a new score

The completed main-branch evaluation at `6448fb2f7ca4d2051a8a03626b1d5674d92f3529` scored **59.3%, Level 3** (81 scored criteria out of 84). Saved report: `f29b55f1-7038-4694-98b0-153675cdcb15`.

It evaluated five current code applications:

- `web/apps/server`
- `web/apps/web`
- `rust/crates/pp-server`
- `rust/crates/pp-desktop`
- `slicer-sidecar`

Rust library crates and the offline performance tool are not extra applications. Do not drop transitional applications from the denominator before retirement, or prioritize legacy sidecar investment over the approved Rust scope simply to improve the score.

Bounded evidence included a web asset build, one executed Rust core unit test, selected Vitest **collection only**, isolated Node/browser smoke, and authenticated Rust gateway mutation/shutdown proof. Desktop test compilation timed out; Python collection lacked pytest. Browser fallback/native-heavy documentation credit was not installed native acceptance.

Adding instructions and a skill closes documentation/discoverability gaps on this branch. It does not change that saved snapshot. Reassessment must identify its own commit and dirty state.

## Runtime migration gates

These gates remain open until their exact-head evidence is attached to the relevant work.

| Gate | Acceptance and existing execution owner |
|------|-----------------------------------------|
| Whole-operation ownership | Include aliases, dispatch, workers, tables, and files. No dual writes, shadow sends, or mutating fallback. See [GRE-402](https://linear.app/greetz/issue/GRE-402), [GRE-339](https://linear.app/greetz/issue/GRE-339), and the unresolved remainder in [GRE-1066](https://linear.app/greetz/issue/GRE-1066). |
| Runtime wiring | A merged crate/library slice is not reachable runtime functionality. Verify the actual launcher/dispatcher and both feature modes. See [GRE-621](https://linear.app/greetz/issue/GRE-621) and [GRE-1065](https://linear.app/greetz/issue/GRE-1065). |
| Persistence and recovery | Preserve SQLite/history, immutable Plan/Plate/Required-unit identities, autosave, and durable receipts. Prove cancellation, crash/restart, backup/restore, and uncertain external-effect reconciliation. See [GRE-1062](https://linear.app/greetz/issue/GRE-1062), [GRE-409](https://linear.app/greetz/issue/GRE-409), [GRE-403](https://linear.app/greetz/issue/GRE-403), and [GRE-404](https://linear.app/greetz/issue/GRE-404). |
| API/MCP and export parity | Prove authenticated HTTP/WS/MCP behavior and simulator parity, plus export/external slicer handoff. Do not infer parity from generated API docs or compilation. See [GRE-1061](https://linear.app/greetz/issue/GRE-1061), [GRE-1060](https://linear.app/greetz/issue/GRE-1060), and contract ownership [GRE-445](https://linear.app/greetz/issue/GRE-445). |
| Installed desktop | Require installed native journeys, permissions, tray/quit/drain, restart, and no-orphan receipts. Mac signing/notarization and display-dependent proof remain separate gates. See [GRE-332](https://linear.app/greetz/issue/GRE-332), [GRE-1063](https://linear.app/greetz/issue/GRE-1063), [GRE-1034](https://linear.app/greetz/issue/GRE-1034), [GRE-1035](https://linear.app/greetz/issue/GRE-1035), and [GRE-448](https://linear.app/greetz/issue/GRE-448). |
| Headless and Node retirement | Prove the single-user Rust Docker runtime, then retire Node only after operation coverage and rollback/cutover evidence. See [GRE-356](https://linear.app/greetz/issue/GRE-356) and [GRE-358](https://linear.app/greetz/issue/GRE-358). Retain old PR/reference stacks until replacement coverage exists. |
| Platforms, release, performance | Three-OS CI is the target, not evidence that Windows runtime support is complete. Keep `com.poitee.printpartner`; signed native stable/beta updater tags are separate from Docker tags. Automation plugins must not ship release artifacts. Require measured performance evidence under [GRE-388](https://linear.app/greetz/issue/GRE-388). |

New desktop slices use default-off Cargo `desktop_rebuild` and runtime `PP_DESKTOP_REBUILD` exactly `1` or `true`. Ownership, enablement, cutover, and installed acceptance are separate claims. Never flip defaults to make a readiness check pass.

## October 29 target acceptance

The following are future acceptance requirements from the Optional Server + AI Connector design. This foundation does **not** implement or enable them. Current [network-sharing documentation](../network-sharing.md) explicitly says the feature does not exist; older placeholder behavior must not be presented as the new contract.

- [ ] **Single owner:** desktop becomes a service client; the service exclusively owns the data folder and database. Desktop must not open that database directly. Resolve service/app update order and version-mismatch policy before shipping this boundary.
- [ ] **Offline default:** one installer, sharing unchecked/off by default. With sharing off, desktop works offline with the local service and no external listener. Do not install an OS service, firewall rule, or external network listener on the default install.
- [ ] **Opt-in service:** Windows service/systemd/launchd installation is optional and tied to sharing. Docker retains the same headless server/sign-in model. Windows named-pipe ACLs and stop-handler prerequisites need proof.
- [ ] **Persistent authenticated sessions:** securely stored pairing survives restart. Revocation terminates live HTTP, WS, and MCP sessions. MCP is authenticated even on loopback. Keep credentials out of databases, backups, and logs; see [GRE-1006](https://linear.app/greetz/issue/GRE-1006).
- [ ] **Explicit exposure:** explicit bind addresses and Host allow-set, including IPv6; no wildcard bind. Use a fixed pinned sharing port. A busy port leaves sharing off with an explanation, not a random LAN port.
- [ ] **Network loss:** losing the Tailscale address disables sharing without LAN fallback. Remaining off when it returns, until manual enable, is the documented **Q9 safe default**, not a new explicit product-owner decision.
- [ ] **LAN secrecy:** no cleartext secrets on non-Tailscale LAN. Require HTTPS/pinning and sniff-proof pairing; pairing connection strings include the certificate fingerprint. Firewall rules are scoped by program, port, and range; Public-profile exposure is limited to Tailscale `100.64.0.0/10`.
- [ ] **Scoped AI:** sessions default to read-only, with per-session allowed-tool lists. Hide write tools from read-only sessions. Proposals are session-owned and scopes are rechecked. Confirm/apply happens in the desktop UI only, never through a network confirmation endpoint. This must not change ordinary Plan autosave.
- [ ] **MCP boundaries:** session rate limits and a retained redacted audit log. Audit retention duration remains unresolved. The stdio proxy has no independent state, tool set, or credentials.
- [ ] **Internet fetch:** off by default; block private/loopback targets. Connect to the checked IP without a second DNS resolution. Warn about prompt injection when fetch and write capabilities are combined.
- [ ] **Discovery privacy:** mDNS must not advertise version or installation ID.

The proposed first networking slice is a Tailscale-only, pinned second listener on Linux/macOS using the existing password session. It excludes HTTPS, mDNS, firewall automation, service installation, and MCP. A later slice adds read-only MCP. The complete target checklist does not enlarge either slice or authorize work by itself.

## Repository readiness work versus product work

| Area | Status and appropriate next step |
|------|----------------------------------|
| Agent instructions and reusable QA | Root instructions, a scoped skill, and a runbook use existing harnesses. `just guidance` validates local links, skill metadata, and trackability; the `agent-guidance` CI job runs the same checks and regression tests. Hosted evidence remains pending until the branch is pushed. |
| CI speed and setup | GRE-975's completed foundation does not mean every item shipped. Runner cache and web sharding moved to maintainer-owned [GRE-1041](https://linear.app/greetz/issue/GRE-1041). Local CI may SKIP unavailable checks and still exit zero. |
| Toolchain consistency | Use the pinned Rust toolchain, Node 24.21 for native assets/runtime, and the separate Node 22.23.3 parity oracle. Do not “fix” the intentional transition by changing all engines to one version. |
| Static quality | Strict TypeScript, TS/Python formatting, hooks, coverage thresholds, complexity/duplication limits, and flag/version-drift checks remain gaps from the baseline. Select a bounded follow-up; do not add a new quality framework or custom general CI guard in this documentation slice. |
| API/schema evidence | Existing generated OpenAPI and contract tools are useful but not proof of a fully versioned Rust-owned public contract. Verify the relevant generation/parity checks and runtime owner for each slice. |
| Privacy and observability | Structured/redacted logs and offline performance capture are not application metrics or release monitoring. Do not add product analytics, alerts, or default-on Sentry merely for score credit. Sentry stays explicit opt-in. |
| Merge and release | Exact-head independent cross-vendor review, green applicable CI, and `pp/score-verified` are required. Older fallback wording is not permission to bypass the October 29 score gate. Signing, release permissions, and protection changes require maintainer action, not a readiness workaround. |

Prefer standard libraries and existing mechanisms, including OS advisory locks ([GRE-636](https://linear.app/greetz/issue/GRE-636)) and established workflow controls ([GRE-635](https://linear.app/greetz/issue/GRE-635)). Farm/order/West3D work and the full UI redesign remain after parity.

## Before assigning a Mission

Use one small, independently verifiable job:

1. Identify the existing issue, current main base, affected application paths, and operation owner. Check for overlapping work and preserve existing changes.
2. State current behavior, target acceptance, feature modes, data/external-effect risks, and explicit exclusions.
3. Choose a finite validation budget and selectors using the [QA runbook](mission-qa.md). Identify display/OS/signing/maintainer gates up front.
4. Require exact-head, nonzero executed proof. Label collection, compilation, browser fallback, historical evidence, SKIPs, and timeouts separately.
5. Keep external writes, service installation, real printer sends, cutover, releases, and product-default changes outside the Mission unless explicitly authorized.
6. Apply the [definition of done](definition-of-done.md), including independent review. Escalate blockers instead of weakening tests, permissions, or gates.
