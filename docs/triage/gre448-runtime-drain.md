# GRE-448 core shutdown evidence

`CoreRuntime` closes tracked-work admission and gateway admission, disarms compat
restarts, and gives both drains the same five-second budget. Shutdown receipts
report `tracked_idle`, `gateway_idle`, and `compat_exit` alongside cleanup results.
`complete()` requires both drains and cleanup to succeed. A forced compat exit can
complete process cleanup, but cannot authorize a cutover.

If tracked Rust work outlives that budget, shutdown reports
`tracked_drain_timed_out` and `storage_ownership_retained`. Compat still terminates
under its existing ten-second SIGTERM grace. The storage lease stays held until
the owning process exits because the tracked task may still write. A same-process
restart refuses even if that task subsequently releases its guard. After process
exit, the next owner can recover the stale lease through the existing startup path.

A gateway drain timeout reports `gateway_drain_timed_out`. Gateway and compat
cleanup still run. Storage release requires proved compat cleanup and an idle
tracked-work gate. No timeout commits an ownership change.

The headless server emits its shutdown receipt before checking completeness.
The streaming smoke test holds a download open through the drain deadline and
requires exit 1 with only `gateway_drain_timed_out`, plus child cleanup, removal
of the runtime directory and owner marker, and reacquisition of the storage lock.
Its ordinary logout case still requires exit 0.
The portable server smoke likewise holds a WebSocket open across SIGTERM and
requires the exact timeout receipt, exit 1, and complete resource cleanup.

The tests in `rust/crates/pp-core/tests/runtime_m0/drain.rs` launch the measured
Node bundle through the public core API. Each case runs in a separate process so
runtime flags and retained leases cannot contaminate another case. They cover:

- Cancellation, rejection of new tracked work and HTTP mutations, release after
  work finishes, and repeated startup without overlapping compat children.
- A five-second tracked-work timeout, exact failure receipt, retained lock,
  refused same-process restart, and successful restart after owner process exit.
- An admitted HTTP request stalled before sending its body, a five-second gateway
  drain timeout, and an incomplete receipt despite successful process cleanup.
- Flag-off cutover refusal while the original runtime remains usable.
- With `desktop_rebuild` and `PP_DESKTOP_REBUILD=1`, a graceful cutover of all four
  catalog GET/HEAD aliases, two recoveries, and unchanged authority bytes.
- Cutover refusal after a tracked timeout or a SIGSTOP-injected compat stall.
  The latter requires the real ten-second grace and records forced termination.

The cutover tests supply a synthetic one-fixture parity receipt to exercise the
lifecycle gate. They do not prove Node/Rust catalog parity. Rust-owned requests
still return `rust_owner_unavailable`; unrelated Node routes remain available.
The timeout safety fix applies without flags. Cutover activation keeps both
existing opt-ins.

Build the current Node/web bundle and measured manifest before running:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_3_drain)'
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-core --test runtime_m0 --features desktop_rebuild --no-tests=fail -E 'test(ticket_t_3_drain)' --success-output immediate
```

The second command runs in the desktop rebuild CI gate and emits exact shutdown,
cutover, and restart evidence. GRE-448 remains In Progress. Worker fencing, Rust
handlers, operator entry, real parity generation, rollback rules, interrupted
upload coverage beyond the already merged fixtures, and Mac logout evidence
remain outside this slice. This is headless unsigned evidence.
