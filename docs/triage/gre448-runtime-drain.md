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

The pp-compat simulator acceptance test
`ticket_t_3_drain_repeated_eof_interrupts_mutation_without_resend` runs three
supervisor starts against a real Node Unix-socket server. Each POST records its
payload before withholding the response. The server ignores SIGTERM so its
recorded EOF and exit prove that shutdown closed the parent pipe. Each cycle
requires graceful shutdown within five seconds, an unknown dispatch outcome,
zero tracked connection tasks, a closed stale endpoint, exactly one accepted
payload, and an absent old process group before the next start. It emits the
exact accumulated event log and failure strings. This proves the compat transport
under a simulator; the merged printer-upload fixtures cover persisted job retry
policy. It does not prove parent death during desktop startup or Mac logout.

The pp-compat simulator test
`ticket_t_3_drain_force_killed_owner_during_startup_kills_group` covers abrupt
owner death during the pending startup setup write. In each of two isolated
supervisor cycles, a real Node process acknowledges execution without reading
stdin. A 1 MiB setup keeps startup pending. The owner confirms `Starting`, no
endpoint, zero health probes, and one child before the outer test stops Node
and kills the Rust owner with SIGKILL.

A live peer in Node's process group prevents POSIX orphan-group SIGHUP from
making the test pass without the parent-death watcher. Node cannot handle stdin
EOF while stopped. Both Node and the peer must terminate within one five-second
wall-clock budget, and the peer must report SIGKILL. The test checks the first
cycle's deaths before starting the second and emits a receipt for each cycle.
Failure cleanup kills the owner and Node groups and reaps direct children.

This proves the supervisor's shell simulator retains the parent-death guard
across the setup await. It does not exercise the measured release spawn path,
desktop storage recovery, or actual Mac logout. Full worker cutover and those
release-level gates remain open.

The startup fixture's negative control temporarily calls
`parent_death.release()` in `Process::spawn_shell`, after child PID recording
and before the setup write. The new acceptance test fails with
`startup group outlived force-killed owner`. Restoring the original guard makes
both cycles pass. No control hook or production change ships. This is a
coverage gap, not a newly fixed production defect.

The final local pp-compat drain selection passed 19 tests with 50 skipped.
Its environment-gated owner helper is outside the drain selection. Run it from
the integration worktree root with a generated measured manifest available:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -p pp-compat -E 'test(ticket_t_3_drain)' --success-output immediate
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-compat --all-targets -- -D warnings
cargo fmt --all --manifest-path rust/Cargo.toml --check
node --check rust/crates/pp-compat/tests/fixtures/startup-no-stdin.cjs
```

The local run supplied an existing manifest through
`PP_DESKTOP_RELEASE_MANIFEST` for compile-time embedding. The startup fixture
uses its checked-in simulator and does not load the manifest's release assets.

The pp-compat simulator test
`ticket_t_3_drain_repeated_eof_joins_unread_response_body` covers shutdown after
response headers arrive while the caller keeps the response body unread. A Node
Unix-socket fixture writes a 1 MiB chunk without ending the response and ignores
SIGTERM. The test retains the body until shutdown has returned and all cleanup
assertions have passed. Each of two supervisor cycles requires a successful
response header, an active connection task, graceful shutdown within five
seconds, zero connection tasks, an unpublished and rejecting stale endpoint,
and an absent child process group before the next start. The exact event log
contains one `GET /stream` and one `EOF` per cycle.

The negative control temporarily removes `self.cancelled.cancel()` from
`Connections::close`. The test fails with
`unread response connection was not joined: Compatibility connection join timed out`.
Restoring the cancellation makes both cycles pass. This proves the connection
join needs cancellation even after pipe EOF and child exit. No production change
or control hook ships. The fixture does not exercise the measured release bundle,
HTTP gateway draining, storage recovery, worker cutover, or actual Mac logout.

Run with a generated manifest available for the build-time embedding prerequisite:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-compat --no-tests=fail -E 'test(ticket_t_3_drain_repeated_eof_joins_unread_response_body)' --success-output immediate
node --check rust/crates/pp-compat/src/fixtures/drain-stream.cjs
```

Local verification supplied `/tmp/gre333-stage/bundle-manifest.json` through
`PP_DESKTOP_RELEASE_MANIFEST` only for compile-time embedding. The negative
control failed 0/1 in 2.321s. The restored drain selection passed 20/20, with
50 skipped, in 30.324s. The new case recorded shutdown at 12ms and 8ms, zero
connection tasks, and the exact event log `GET /stream\nEOF\n` twice. These are
simulator acceptance results, not release performance measurements.
