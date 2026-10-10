---
name: verify-print-partner-rust
description: >
  Build and drive Print Partner's Rust gateway/server in rust/crates. Use for
  Rust runtime endpoint verification and headless end-to-end proof, including
  isolated startup, authenticated reads and writes, and shutdown.
---

# Verify Print Partner Rust

## Launch

Run from the repository root (Linux, Python 3, Cargo and Node/npm required;
use the toolchain versions documented in `rust/README.md`):

```bash
set -o pipefail
python3 .cursor/skills/verify-print-partner-rust/helpers/verify.py 2>&1 | tee /tmp/pp-verify-rust.log
```

The helper builds the web compatibility bundle, generates its release manifest,
then builds `pp-server` with locked Cargo dependencies. It launches that Rust
binary with disposable data and uses the **loopback origin printed by Rust**,
not the Node skill's `:8080` or a LAN instance. Rust supervises the Node
compatibility server over a private Unix socket; this proves the Rust gateway
path, not an entirely Rust-owned backend or native desktop UI.

Ready signal: the owned Rust process prints `http://127.0.0.1:<port>` after
startup. The helper exchanges its private bootstrap credential for a session.

## Doctor

The helper checks `/health` returns `{ "ok": true }` and `/__runtime` reports
`compat.state == "ready"` on that owned origin before driving the feature.
Rerun the command with fresh disposable data if those checks fail.

## Drive

The run checks unauthenticated denial, exchanges the one-use desktop bootstrap
for a session, checks `/health`, `/__runtime` and the `/builds` HTML document,
then creates a Source through `/sources` and reads it back. Every request prints
its actual status and result; failed expectations fail the command. Bootstrap
tokens and session cookies are never printed.

## Evidence

Capture the transcript at `/tmp/pp-verify-rust.log` with the command above. It
records the checkout commit, builds, actions, response bodies and cleanup.
Attach the **full real output**, including build output and final `PASS`, to the
PR as proof. Failures are evidence too; do not replace them with claimed success.
Creating a Source through the gateway and reading it back proves the side effect
through the public API. No production data or mocked backend is used.

## Cleanup

The helper always terminates only its own server. A successful run requires a
zero shutdown exit, removal of the owner marker and private socket directory,
and reacquisition of the data lock. It deletes its credentials and disposable
data; the captured transcript survives. Confirm `test -s /tmp/pp-verify-rust.log`
after the run.

## Helpers

`helpers/verify.py` owns the complete build/start/doctor/drive/stop lifecycle.

If this checkout lacks `rust/`, fail with exactly
`rust/ not found; check out the desktop chain`. To
verify a separately agreed Rust checkout while keeping the skill diff on main:

```bash
python3 .cursor/skills/verify-print-partner-rust/helpers/verify.py --repo /path/to/rust-checkout
```

The transcript records that checkout's commit. Keep the distinction explicit in
the PR; this smoke run does not cover the full desk-loop browser journey.
