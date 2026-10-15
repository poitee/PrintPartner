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

## Measured release startup parent death

`ticket_t_3_drain_measured_release_startup_parent_death` adds the measured
`Process::spawn` path to the startup proof. It is an ordinary pp-compat unit
test, with no ignore or environment skip. The desktop runtime and fleet Rust
CI jobs already build the web assets and embed their measured manifest. The
test uses that embedded identity, the repository web assets, and native
`/usr/bin/node`. Missing assets or a mismatched manifest fail the test.

The `record_child` callback records the PID, stops Node, and returns a test
ownership marker. A 1 MiB lease then backpressures the real setup write. On the
owner's current-thread Tokio runtime, the owner task resumes only after spawn
has yielded. Before acknowledging startup, the owner requires stopped Node,
`Starting`, no published endpoint, zero completed health probes, and one child.
This tests startup before setup delivery, without requiring backend readiness
or opening desktop storage.

The existing RAII fixture now runs both the shell and measured cases. The
measured case allows 30 seconds to reach startup while verifying full CI assets.
The shell case keeps its eight-second startup bound. Each measured case has
two sequential cycles. A live peer joins Node's group before
the Rust owner receives SIGKILL. It excludes orphan-group SIGHUP as the reason
for cleanup. Stopped Node cannot process stdin EOF. Owner exit, Node death, and
peer death share one five-second deadline. The direct peer must report SIGKILL.
Each cycle proves both processes dead before the next cycle starts. Failure
cleanup kills both groups and reaps the direct owner and peer.

This worktree has no built web assets. The local rerun script builds an explicit
measured simulator package with a copy of native Node v24.21.0, a preload, and
an entry that leaves stdin unread. It invokes the unchanged release manifest
builder, embeds that manifest through `PP_DESKTOP_RELEASE_MANIFEST`, and uses
`PP_COMPAT_MEASURED_STARTUP_STAGE` only to select those assets in the test.
`verify_bundle` and the real spawn's `verify_backend` both run. The simulator
entry records its PID and preload marker before the callback stops it. The
fixture asserts both markers and unread stdin. The package includes minimal
measured metadata, frontend, contract, domain, and dependency files. These are
simulator assets, not a production backend bundle or a substitute for release
verification. No generated manifest or verification bypass is checked in.

Run the bounded fail-before/pass-after proof from the repository root:

```sh
python3 rust/scripts/prove-measured-startup-death.py --negative-control --evidence /tmp/gre448-proof
```

The script first requires one passing acceptance test with two cycle receipts.
It temporarily calls `parent_death.release()` only in measured `Process::spawn`,
then requires exit 101 and `startup group outlived force-killed owner`.
A `finally` block restores `lib.rs` byte-for-byte before another passing run.
The script records its restored source hash and directly checks that negative
failure cleanup left no live owner, Node, or peer. There is no production code
change or control hook in the committed diff.

The exact Cargo command for all three runs is:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-compat --lib ticket_t_2::ticket_t_3_drain_measured_release_startup_parent_death -- --exact --nocapture
```

The two environment variables and generated asset paths are recorded in
`/tmp/gre448-proof/environment.json`. `commands.log` records the manifest and
Cargo commands. `baseline.log`, `negative.log`, and `restored.log` retain the
full results. `negative-cleanup.json` records the post-failure process states;
`restored-lib-sha256.txt` records the restored production source hash.

Local results prove measured simulator startup on Linux. CI execution against
the full built web bundle remains to be reviewed by the parent. Mac logout,
storage recovery, worker fencing, and full worker cutover remain outside this
slice.

The final local proof passed one baseline test, failed one negative test with
exit 101 at the intended five-second invariant, and passed one restored test.
Both passing runs completed two cycles. All three recorded negative-control
processes were absent after failure cleanup. The final pp-compat drain selection
passed 21 tests with 60 skipped. Clippy with warnings denied, workspace format
checking, both Node syntax checks, and Python syntax checking passed. A supplied
shell dispatcher was rejected without execution or stage creation.

For local follow-up checks, export both values from `environment.json` before
running these commands. Full logs are `drain.log`, `clippy.log`, `fmt.log`,
`syntax.log`, and `native-rejection.log` in the same evidence directory.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -p pp-compat -E 'test(ticket_t_3_drain)' --success-output immediate
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-compat --all-targets -- -D warnings
cargo fmt --all --manifest-path rust/Cargo.toml --check
node --check rust/crates/pp-compat/tests/fixtures/measured-startup-entry.cjs
node --check rust/crates/pp-compat/tests/fixtures/measured-startup-preload.cjs
```

The review follow-up validates Node v24.21.0, ABI 137, host OS, and host
architecture before creating evidence or simulator directories. Native binary
validation still precedes execution. `node-identity.json` records the queried
identity. Negative cleanup checks every owner, Node, and peer tuple in the log.

The rerun with `--negative-control --evidence /tmp/gre448-proof-review1` passed
baseline and restored tests with two cycles each. The negative test exited 101
at `startup group outlived force-killed owner`; all three recorded PIDs were
absent afterward. An independent byte comparison confirmed unchanged `lib.rs`.
The focused script tests passed four cases, including a synthetic two-cycle log
and real `ps` rejection of a live second-cycle PID in each role. Mocked identity
queries against a native executable proved wrong version, ABI, OS, and
architecture fail before evidence or stage creation. Dispatcher rejection,
Python compilation, and all seven existing stager self-tests also passed.
Focused results are in `/tmp/gre448-proof-review1/script-tests.log`.

```sh
python3 -m unittest discover -s rust/scripts -p test_prove_measured_startup_death.py -v
```

The second review follow-up uses resolved `sys.executable` for mocked identity
tests and accepts the stager's complete nine-header ELF, Mach-O, and FAT set.
All five proof-script tests passed, including nine header subcases that reach
identity validation, canonical header-set equality, and dispatcher rejection
before execution. All seven stager self-tests passed. Logs are
`/tmp/gre448-proof-review2/script-tests.log` and `stager-tests.log`.

The bounded rerun with `--negative-control --evidence /tmp/gre448-proof-review2`
passed one baseline and one restored test with two cycles each. The negative
test failed once with exit 101 at `startup group outlived force-killed owner`.
All three recorded PIDs were absent afterward. An independent byte comparison
confirmed unchanged `lib.rs`, recorded in `source-restoration.log`. Full driver
results are in `driver.log`, `baseline.log`, `negative.log`, and `restored.log`
in that evidence directory. No Rust or stager changes were retained.

## Measured release repeated start, stop, and EOF cleanup

`ticket_t_3_drain_measured_release_repeated_eof_cleanup` runs three sequential
supervisor cycles through measured `Process::spawn`. Each cycle owns its scratch
directory and recorded process group. The completed cycle records retain their
literal event logs. Before the next spawn and while its successor is ready, the
test checks that every prior group is absent, its spawn count remains one, and
its event log has not changed.

Each cycle holds an unread 1 MiB response body and sends one POST. The fixture
records the accepted payload but withholds its response. Shutdown must finish
within five seconds with `Graceful`, zero connection tasks, an unpublished
endpoint, `Stopped`, and an absent child group. The retained endpoint must reject
a new POST with `Compatibility generation is stopping`. The interrupted POST
must return `Compatibility dispatch outcome unknown`. The held response body
stays alive until all cleanup assertions pass. The exact per-cycle log is:

```text
SPAWN <pid>
GET /stream <pid>
POST /upload payload-<cycle> <pid>
EOF <pid>
EXIT <pid> 0
```

The lifecycle entry needs a server and a flowing setup pipe. Extending the
startup entry would defeat its unread-stdin invariant, so this slice adds one
separate entry and reuses the existing native Node validation, measured package
builder, preload, and proof driver. The entry ignores SIGTERM. A graceful exit
therefore requires observed stdin EOF. The real release verifier measures the
Node executable, preload, entry, frontend, metadata, contracts, domain, and
simulator dependency inventory. No production guard, verification bypass, or
control hook is added.

Run the bounded proof from the repository root:

```sh
python3 rust/scripts/prove-measured-startup-death.py --scenario lifecycle --negative-control --evidence /tmp/gre448-lifecycle-proof2
```

The driver requires one executed acceptance test and all three cycle receipts.
Its negative control temporarily removes `self.cancelled.cancel()` from
`Connections::close`. The unread body must then fail owned connection cleanup
with `Compatibility connection join timed out`. A `finally` block restores
`lib.rs` byte-for-byte before a passing rerun. The driver records the restored
source hash and checks that every PID reported by the failing test is dead.
This establishes a coverage gap. Production cleanup already works.

The test is explicitly ignored in ordinary unit selections because its embedded
manifest must identify the lifecycle simulator, rather than the startup simulator
or production backend. The driver selects this exact test with `--ignored` and
rejects zero tests or missing cycle receipts. The desktop runtime workflow runs
the driver as a required step after its built-backend unit and lint checks.
It generates and validates the simulator assets in the retained evidence
directory before running Cargo. This CI step exercises measured simulator
assets, not the production backend's HTTP or persistence behavior.

`environment.json` records both manifest and stage selectors. `commands.log`
records the exact manifest and Cargo invocations. `asset-identity.json` records
the manifest, native Node, entry, and preload hashes and the source commit.
`baseline.log`, `negative.log`, `restored.log`, `negative-cleanup.json`, and
`restored-lib-sha256.txt` retain the proof evidence. Startup remains the driver's
default scenario.

This is Linux headless simulator acceptance evidence for the measured spawn,
transport, and cleanup path. It does not prove storage recovery, persisted job
retry policy, production backend shutdown, worker fencing, full worker cutover,
or Mac logout. GRE-448 remains open. The next release-level slice is to prove
these lifecycle observations against the full built backend with its real
storage ownership and interrupted request behavior.

Initial local verification used native Node v24.21.0, ABI 137, Linux x64. The measured
simulator manifest identifies source baseline
`c65dee177c5b1e0c4754d474d5c6b7b9917997b7`. Its SHA-256 is
`498537e8eec435a4f9bc4258ef3e43ab32edc307b72a490e6ca3cbed729096c7`.
The entry SHA-256 is
`be7e5e3f94825bff4fb6a46646ff2b5749ae442fb450ca10cc4e5cf86105f338`.
The complete native Node and preload identities are in `asset-identity.json`.
The final bounded proof in `/tmp/gre448-lifecycle-proof2` passed one baseline
test with three cycles in 6.27s, failed the intentional negative test with
exit 101 at the owned join timeout in 4.77s, and passed one restored test with
three cycles in 5.93s. The negative PID was absent afterward. The independent
source hash matches `restored-lib-sha256.txt`, and `lib.rs` has no final diff.
These durations describe acceptance runs, not release performance.

The unchanged default startup scenario also passed its two-cycle proof in
`/tmp/gre448-lifecycle-startup-regression`. Five driver unit tests, Python
compilation, the new Node fixture's syntax check, workspace format checking,
and pp-compat Clippy with warnings denied passed. Supporting logs are
`script-tests.log`, `fmt.log`, and `clippy.log` in the lifecycle evidence directory.

The nonzero drain selection passed 21/21 with 72 skipped in 30.329s, using the
startup simulator manifest for the existing measured startup case. Export both values from
`/tmp/gre448-lifecycle-startup-regression/environment.json` before the Cargo
commands below. The output is in `drain.log`. The new lifecycle case runs
separately under its own measured manifest through the driver above.

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -p pp-compat -E 'test(ticket_t_3_drain)' --success-output immediate
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-compat --all-targets -- -D warnings
cargo fmt --all --manifest-path rust/Cargo.toml --check
python3 -m unittest discover -s rust/scripts -p test_prove_measured_startup_death.py -v
node --check rust/crates/pp-compat/tests/fixtures/measured-lifecycle-entry.cjs
```

## Built backend repeated EOF cleanup

`rust/tests/built_backend_lifecycle.py` runs the built
`web/apps/server/dist/current/desktop.js` with its real dependency tree and native
Node. It supplies the desktop ownership marker, inherited lock descriptor 198,
and parent setup protocol. Signed Unix-socket `/health` requests require an
available SQLite database and an authenticated desktop principal before each
shutdown.

Three sequential cycles reuse one data directory. Each cycle closes the setup
pipe while the Python owner stays alive. A test-only preload records stdin EOF,
received signals, and the application's process-group kill without replacing the
server entry, routes, database, or shutdown implementation. The harness requires
EOF before the application's kill, no SIGTERM, child exit, an absent process
group, and a removed socket before the next start.
Receipts identify the resolved Node version and ABI, built entry digest, server
package version, health response, and prior child identities.

Run after `npm --prefix web ci` and `npm --prefix web run build`:

```sh
python3 rust/tests/built_backend_lifecycle.py --node "$(command -v node)" --negative-control --evidence /tmp/gre448-built-backend
```

Each invocation prints and creates a unique `run-*` directory under the supplied
evidence root. Repeating the command preserves all previous receipts.

The negative control suppresses stdin EOF delivery in the test observer. It must
fail the same bounded shutdown assertion after real health readiness. Failure
cleanup kills and reaps the owned child. The driver then restores normal EOF
delivery and requires three further cycles to pass. Production source and built
assets stay unchanged during this control. Desktop runtime CI runs this command
against its freshly built backend and uploads the receipts and logs.

This is Linux headless evidence for the built backend's EOF path. It does not
exercise the Rust supervisor's measured spawn path, interrupted printer uploads,
full worker cutover, startup parent-death, or actual macOS logout. Those areas
retain their separate evidence and remaining ticket gates.

The owner independently ran the full command on 2026-10-15 with native Node
v24.21.0, ABI 137, Linux x64. Three baseline and three restored cycles passed.
The suppressed-EOF cycle failed with `backend did not stop after stdin EOF`;
its guard recorded external cleanup and no remaining PID or group. All six
positive guards recorded no external signal. All seven child PIDs were absent
when checked after completion. The built entry digest stayed
`0356744362f0fa28e5ad3ed516de7fc71aca167af7fa6428a4e6b87650541bc7`.
Local receipts are in `/tmp/gre448-built-proof/owner-proof`. This negative control
proves the test detects missing EOF delivery; it does not identify a new
production defect. Python compile, Node syntax, native dispatcher rejection,
comment review, and diff checks passed. The implementation child independently
ran the same complete proof before the owner's rerun.

Review found that reusing the documented evidence root raised `FileExistsError`
after overwriting its artifact identity. The owner reproduced that failure, then
ran the corrected command twice against the existing root. Both isolated runs
passed three baseline cycles, the expected negative control, and three restored
cycles. All 14 child PIDs were absent, and all 60 original evidence files stayed
byte-for-byte unchanged. The isolated receipts are under
`/tmp/gre448-built-proof/owner-proof/run-9dy9pxzk` and `run-7pjt7tgu`.
