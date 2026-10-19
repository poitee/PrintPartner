# GRE-634 process-group cleanup evidence

The failure is test interference on Linux. Production group cleanup is unchanged.
`ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced` enabled
`PR_SET_CHILD_SUBREAPER` in the shared libtest process. That setting applies to
every thread. Concurrent tests' orphaned descendants could therefore become
children of the test runner instead of the normal ancestor reaper. Restoring
the setting does not
release children already adopted. The fixture reaped only its own descendants.

The fix runs that fixture in a dedicated process. Other tests retain their
strict assertions that both the descendant PID and its process group disappear.
It does not add retries, increase cleanup deadlines, or ignore zombies.

## Re-execution proof

The Linux subreaper fixture captures its child test executable's output. A
successful proof requires exit status zero, exactly one passing result for the
named fixture, and one libtest summary with one passed test and no failures,
ignored tests, or measured tests. A missing exact test name exits zero with zero
tests, which the validator rejects. The existing descendant assertions still
run in the isolated child.
The launcher inherits stderr so a paused descendant cannot keep a failed
fixture's captured stderr pipe open.

Run these commands from `rust/` to prepare disposable simulator assets and
verify the two regressions and the original fixture in both feature modes.

```sh
CARGO_TARGET_DIR=/path/to/disposable-target python3 scripts/prove-measured-startup-death.py --evidence /path/to/disposable-evidence
```

Read `/path/to/disposable-evidence/environment.json` and export its values as
`PP_DESKTOP_RELEASE_MANIFEST` and `PP_COMPAT_MEASURED_STARTUP_STAGE`. Keep both
variables set for full package suites. Export `CARGO_TARGET_DIR` with the same
disposable target path for the following commands.

```sh
cargo test -p pp-compat --locked --no-default-features --lib subreaper_reexec
cargo test -p pp-compat --locked --no-default-features --lib ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced
cargo test -p pp-compat --locked --features desktop_rebuild --lib subreaper_reexec
cargo test -p pp-compat --locked --features desktop_rebuild --lib ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced
```

Each regression command runs two tests. Each original-fixture command runs one
test. `subreaper_reexec_runs_exactly_one_fixture` runs the actual fixture in a
child executable. `subreaper_reexec_wrong_name_is_failure` confirms that the
child exits zero with zero tests and that validation rejects its output.

## Captured failure

Base was `a5e8b16f0f1ea15d1a6e5c4228fb66a1e5148aeb`. Four CPU burners ran
alongside each loop. The full 84-test suite failed on run 3 after two passes.
The two implicated tests together failed on run 1.

Temporary test instrumentation called `ps -e -o pid,ppid,pgid,sid,stat,comm`
before leader death and immediately after `drive_shutdown_group` returned.
The paired run captured this state before cleanup.

```text
    PID    PPID    PGID     SID STAT COMMAND
1814964 1814960 1814964 1814924 S    sh
1814965 1814964 1814964 1814924 S    sh
1814966 1814965 1814964 1814924 S    sleep
```

After cleanup, both descendants were zombies adopted by the test runner,
PID 1814960. Neither escaped process group 1814964.

```text
    PID    PPID    PGID     SID STAT COMMAND
1814965 1814960 1814964 1814924 Z    sh
1814966 1814960 1814964 1814924 Z    sleep
```

The function returned `Process group still present`, caused by `Child reap
failed`, caused by `No child processes (os error 10)`. The test failed with
`grandchild survived a failed leader wait`. SIGKILL had killed the descendants.
`kill(pid, 0)` still found their unreaped PIDs. This rules out a process-group
escape, delayed SIGKILL delivery, and PID reuse for this failure.

With fixture isolation, the same paired run captured this group before cleanup.

```text
    PID    PPID    PGID     SID STAT COMMAND
1820570 1820566 1820570 1820559 S    sh
1820574 1820570 1820570 1820559 S    sh
1820576 1820574 1820570 1820559 S    sleep
```

After cleanup, `ps` found no members. The function returned the expected
`Child reap failed` error without `Process group still present`.
Both tests passed. The temporary instrumentation that sampled healthy runs is
excluded from the fix. Failure diagnostics retain a group snapshot.

## Isolated fixture publication

Before atomic PID-file publication, the isolated loop failed at run 153 with
`ParseIntError { kind: Empty }` while reading the Node descendant PID. The file
existed before `fs.writeFileSync` finished writing its contents. The fixture now
publishes that file by rename, matching its owner PID file.

The isolated loop also failed the Node exit assertion at run 65 in 0.61 seconds.
After atomic publication, another run failed the descendant exit assertion at
run 226 in 0.56 seconds. Both five-second polling loops had already observed
exit, but subsequent probes discarded that success.

A separate loaded probe captured the observation race on run 18. PID 1845574
started as a live `sleep` in group 1845573. `/proc/1845574/stat` then reported
`Z`. A later `kill(1845574, 0)` succeeded, but reading its proc entry immediately
afterward found no file. `ps -o pid,ppid,pgid,sid,stat,comm -p 1845574` returned
only the header. The old combined probe returns false for that torn observation.
The test now retains a successful exit observation instead of checking the
disappearing PID again. Its polling interval and deadline are unchanged.

## Subreaper fixture leader

Two longer loaded paired runs exposed a separate failure in the subreaper
fixture itself, at runs 173 and 384. The failed-wait cleanup test passed in
both cases. The fixture's descendant waiter timed out after five seconds.
At that moment, the leader was still alive in `anon_pipe_read`, and its
descendant was alive in `__do_sys_pause`.

```text
    PID    PPID    PGID     SID STAT COMMAND
1852557 1852553 1852557 1835171 S    python3
1852561 1852557 1852557 1835171 S    python3
```

This was the planned-shutdown case, with no previously observed exit and no
EOF cancellation. The fixture installed a Python SIGTERM callback that called
`sys.exit(0)` while the leader blocked reading stdin. It now uses `SIG_DFL`.
The OS terminates the leader on SIGTERM, while the descendant still ignores
SIGTERM and requires group SIGKILL. All five shutdown scenarios and the
descendant's exact SIGKILL status assertions remain intact.

## Independent simulator assets

Each simultaneous verification run needs its own measured simulator directory.
An initial full-suite soak stopped at run 8 because its startup receipt shared
a directory with nextest. The receipt contained PID 1873549 while that test
expected PID 1873603. The suite log finished at 10:10:15 UTC and nextest at
10:10:16 UTC. The final soak uses a dedicated copy of the measured simulator.
This setup correction does not change or skip a test.

## Reproduction

Prepare simulator assets with the repository's existing
`rust/scripts/prove-measured-startup-death.py --evidence <evidence>/measured`.
It generates a measured native Node simulator and runs its startup-death proof.
These are simulator assets, not a built production web bundle.

Read the two generated paths in `<evidence>/measured/environment.json`.
Set `PP_DESKTOP_RELEASE_MANIFEST` for Cargo and
`PP_COMPAT_MEASURED_STARTUP_STAGE` for full-suite execution. Build with
`cargo test --locked --manifest-path rust/Cargo.toml -p pp-compat --lib --no-run`.
Use the executable path printed by Cargo as `<binary>` below.

Run each command through the configured landing slot wrapper.

```sh
python3 rust/crates/pp-compat/tests/stress-group-cleanup.py --binary <binary> --scope pair --runs 200 --evidence <evidence>/pair
python3 rust/crates/pp-compat/tests/stress-group-cleanup.py --binary <binary> --scope alone --runs 200 --evidence <evidence>/alone
python3 rust/crates/pp-compat/tests/stress-group-cleanup.py --binary <binary> --scope suite --runs 200 --cpus 4 --evidence <evidence>/suite
```

On Linux, each loop confines itself and its burners to the selected CPUs.
The suite uses 12 test threads so tests still share a concurrent libtest
process. The runner checks that the target tests exist and are not ignored,
then requires a successful process exit and the expected final libtest summary.
Suite runs must report every unignored test as passed and zero filtered tests.
The script stops at the first failure, saves its output and a process snapshot,
and terminates its CPU burners on exit.

## Interleaved runner output

At acceptance run 182, all 82 tests passed with zero failures. The original
stress script nevertheless stopped because it searched for contiguous status
lines. Output from a nested fixture split one passing line into these fragments.

```text
test tests::separate_group_child_dies_with_force_killed_parent ...

ok
```

The final summary remained intact.

```text
test result: ok. 82 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 31.23s
```

An audit confirmed that all first 182 saved suites had successful unfiltered
summaries. The remaining 18 suites run in a separate evidence directory; no
failed test execution is repeated. The corrected validator uses the final
summary instead of individual status lines. It also checks the binary's test
inventory, rejects missing or ignored target tests, and retains nonzero-exit
failures. It cannot accept a nested passing summary over a filtered root suite.

The CLI regressions reproduce the interleaved output and exercise both failure
guards. They failed before the validator correction and pass afterward.

```sh
python3 rust/crates/pp-compat/tests/test_stress_group_cleanup.py
```

## GRE-733 macOS group lifetime

The failed-leader-wait fixture now owns both processes in the group. Each shell
execs `/bin/sleep 300`, so neither process creates descendants. The member
ignores SIGTERM. After exact-PID `waitpid` reaps the killed leader, the fixture
runs `drive_shutdown_group` and the member's waiter concurrently. It requires
SIGKILL for the member, `ECHILD` under the exact `Child reap failed` message,
and `ESRCH` for the group within the original two-second bound. A five-second
watchdog fails before explicit member cleanup can satisfy those assertions.
The fixture runs 50 cases per macOS invocation and one per Linux invocation.
These are stress cases. The first failure aborts the test.

Apple's [XNU group signal implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c#L1675) filters `SZOMB` members
from explicit process-group probes. An existing group with no eligible members
returns `EPERM`. [Child reaping](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exit.c#L2827) removes it from its group.
The macOS-only `ticket_t_3_drain_zombie_group_remains_until_owned_child_is_reaped`
test checks that mechanism with an owned child. Exact-PID `waitid` with
`WNOWAIT` observes the exit without reaping it. Before reaping, the test requires
`EPERM` and production `process_group_absent` to return false. After reaping,
it requires `ESRCH` and true.

The historical macOS failure reported `EPERM` with no matching `ps` rows.
That observation is consistent with a zombie-only group, but does not prove
the exact historical process state. The old fixture orphaned descendants and
depended on launchd to reap them within two seconds. The new fixture removes
that dependency. The macOS-only test runs through the existing macOS CI gate; Linux stress
alone cannot establish these kernel semantics.
Production `drain.rs` and the true-descendant tests are unchanged.
