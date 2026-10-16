# GRE-634 process-group cleanup evidence

The failure is test interference on Linux. Production group cleanup is unchanged.
`ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced` enabled
`PR_SET_CHILD_SUBREAPER` in the shared libtest process. That setting applies to
every thread. Concurrent tests' orphaned descendants could therefore become
children of the test runner instead of PID 1. Restoring the setting does not
release children already adopted. The fixture reaped only its own descendants.

The fix runs that fixture in a dedicated process. Other tests retain their
strict assertions that both the descendant PID and its process group disappear.
It does not add retries, increase cleanup deadlines, or ignore zombies.

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
process. Every run must succeed and report the selected tests as passed.
The script stops at the first failure, saves its output and a process snapshot,
and terminates its CPU burners on exit.
