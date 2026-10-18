# Subreaper proof contract

The Linux subreaper proof depends on libtest's pretty-format stdout to establish that its isolated fixture passed exactly once.
A successful child exit alone cannot establish that guarantee. Libtest also exits successfully when an exact test filter matches no tests.
[PR #637](https://github.com/poitee/PrintPartner/pull/637) added the exact-once validation.
Its [Opus review](https://github.com/poitee/PrintPartner/pull/637#issuecomment-6252366682) identified the output-format dependency and duplicate execution as follow-ups for GRE-897.

This document describes the implementation in [pp-compat/src/lib.rs](../../rust/crates/pp-compat/src/lib.rs).
The relevant symbols are `SUBREAPER_FIXTURE`, `run_subreaper_fixture`, `validate_subreaper_fixture`, and the three tests named below.
All are Linux-only. The proof is compiled with and without `desktop_rebuild`.

## Isolation and the completed fixture

`SUBREAPER_FIXTURE` names `tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced`.
The launcher reexecutes `std::env::current_exe()` with these libtest arguments:

```text
--exact tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced --format=pretty --color=never
```

The child receives `PP_COMPAT_SUBREAPER_FIXTURE=1`.
The fixture checks whether that variable exists, rather than checking its value.
Without the variable, the original test launches the isolated child, validates its output, and returns.
With the variable, the child sets `PR_SET_CHILD_SUBREAPER` and executes the fixture body.
This keeps the subreaper setting out of the parent test process.
An inherited variable in a developer's shell would bypass that outer launch, so verification commands below unset it.

The body runs five combinations of planned shutdown, an already-exited leader, and cancellation on EOF.
Each combination starts a Python leader with a descendant that ignores SIGTERM.
The assertions require the descendant to be reaped after SIGKILL, the process group to be absent, and new connections to be rejected.
The stop result must report `StopIntent::PlannedShutdown` and `CompatExit::Forced`.
The exact-once guarantee applies to the completed libtest fixture, which includes all five combinations.

The launcher captures stdout and inherits stderr.
It deliberately omits `--nocapture`, so libtest captures successful fixture prints instead of mixing them into the parsed stdout.
The Python leader has a separate piped stdout and inherits stderr.
Inheriting the launcher's stderr avoids a captured stderr pipe that a paused descendant could keep open after the fixture exits.

## The accepted stdout and loud failure

`validate_subreaper_fixture` first requires a successful exit status and UTF-8 stdout.
It removes empty lines with `line.is_empty()` and requires exactly these three remaining lines:

```text
running 1 test
test tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; N filtered out; finished in T
```

`N` and `T` are placeholders in this illustration.
The validator requires the exact summary prefix through `0 measured; ` and the separator ` filtered out; finished in `.
It parses `N` as `usize`. It does not validate `T`, including its duration or unit.
Whitespace-only lines are not empty lines and therefore count toward the three-line requirement.
The test name and result line must match exactly.
The `--format=pretty` and `--color=never` flags are part of this text contract.
The validator reads the child's libtest output, not nextest's own status display.

The failure messages distinguish the following cases:

- An unsuccessful child status returns `isolated subreaper fixture failed`.
- Invalid UTF-8 returns `isolated subreaper fixture output is not UTF-8`.
- A line-count, name, result, summary, or filtered-count mismatch returns `isolated subreaper fixture did not pass exactly once`.

Both successful-launch callers assert that validation returns `Ok(())` and include the child `Output` in the assertion diagnostic.
A toolchain change to the checked wording therefore fails the parent test loudly.
A change confined to the unchecked timing suffix does not necessarily fail validation.
This dependency is intentional. Accepting exit status zero or loosening the match to a generic success substring would lose the exact-once evidence.

## Negative controls and duplicate nextest execution

`subreaper_reexec_runs_exactly_one_fixture` launches the real fixture and requires valid output.
It then mutates that captured output into four rejected controls:

- The complete stdout repeated twice.
- The fixture name replaced with `unrelated_fixture`.
- `1 passed;` replaced with `2 passed;`.
- `0 failed;` replaced with `1 failed;`.

`subreaper_reexec_wrong_name_is_failure` launches an exact name ending in `_missing`.
It confirms exit code zero and `running 0 tests`, then requires validation to reject the output.
That control reproduces the false success that an exit-status-only check would accept.

For a nextest suite that selects all three tests, there are two real fixture executions:

- The original drain test launches and validates one isolated fixture.
- `subreaper_reexec_runs_exactly_one_fixture` launches and validates another isolated fixture before its malformed-output checks.

The wrong-name test launches another libtest process but executes zero fixtures.
The four mutations do not launch children.
Each real fixture execution includes the five combinations described above.
Retries or repeated suite runs can add executions beyond these two.
The [Rust cross-OS workflow](../../.github/workflows/rust-cross-os.yml) has separate nextest passes with `desktop_rebuild` off and on.
On Linux, selecting these tests in both passes therefore executes the fixture body four times before any retries.

The #637 review reported about 0.14 seconds per fixture execution in that PR's CI.
That is historical evidence, not a current benchmark or a timing guarantee.
The duplication is small enough to leave in place for this documentation slice.

## Consolidation assessment

A later source change could make one test own both the real fixture launch and the four malformed-output controls.
That would require restructuring the current tests, because each successful-launch caller currently creates its own child.
It must preserve isolation of `PR_SET_CHILD_SUBREAPER`, the five cleanup combinations, and validation of one completed, correctly named fixture.
It must also retain all four malformed-output controls and the real zero-test, successful-exit control.
Sharing mutable launch results between independently scheduled nextest tests would add coordination to a proof that currently has none.
Given the historical cost, retaining the duplicate launches is preferable until consolidation demonstrates the same guarantees with simpler test ownership.
No executable consolidation is part of GRE-897's documentation slice.

## Focused verification

These commands run from the repository root on Linux with Python 3 and cargo-nextest available.
`pp-compat`'s [build script](../../rust/crates/pp-compat/build.rs) requires a measured desktop manifest even for this focused test selection.
It uses `PP_DESKTOP_RELEASE_MANIFEST` when set, otherwise `rust/bundle-manifest.json`.
The workflow linked above generates that manifest before Rust checks.
For a local run, point `PP_DESKTOP_RELEASE_MANIFEST` at an existing measured development manifest.
These fixtures use temporary processes and runtime directories, not saved user plans.

On the fleet VMs, use the installed Cargo semaphore, three build jobs, and the shared sccache wrapper:

```sh
export CARGO_BUILD_JOBS=3
export RUSTC_WRAPPER=/opt/agent-fleet/bin/sccache
export PATH="/persist/home/.local/bin:$PATH"

env -u PP_COMPAT_SUBREAPER_FIXTURE cargo nextest run \
	--manifest-path rust/Cargo.toml --locked -p pp-compat --lib \
	--no-default-features \
	-E 'test(=tests::subreaper_reexec_runs_exactly_one_fixture) | test(=tests::subreaper_reexec_wrong_name_is_failure) | test(=tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced)'

env -u PP_COMPAT_SUBREAPER_FIXTURE cargo nextest run \
	--manifest-path rust/Cargo.toml --locked -p pp-compat --lib \
	--no-default-features --features desktop_rebuild \
	-E 'test(=tests::subreaper_reexec_runs_exactly_one_fixture) | test(=tests::subreaper_reexec_wrong_name_is_failure) | test(=tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced)'
```

Each command must report three tests passed. A zero-test run is not verification.
After a libtest format change, inspect the actual child stdout, update only the changed format assumptions, and rerun both commands.
The wrong-name control must still prove that successful execution of zero tests is rejected, and all malformed-output controls must still fail validation.
