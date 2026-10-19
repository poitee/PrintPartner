# Accepted STL export timeout diagnosis

GRE-928 remains open. This slice adds a repeatable synthetic diagnostic and local evidence. It does not establish the cause on the failing CI runner or change export behavior.

## Reported failure

[PR #783's web job](https://github.com/poitee/PrintPartner/actions/runs/39244973367/job/118034584031) passed 4,252 server tests with one skipped. Its separate accepted-STL run passed 26 of 27 tests. The 10,001-unit case exceeded its existing 60,000 ms deadline. The job used the self-hosted `pp-local` runner `pp-linux-3-1792416345`.

The exporter and regression test on main `de5a8934974054ce46cac32c4d82d7637f161455` match [GRE-330's PR #113](https://github.com/poitee/PrintPartner/pull/113). That change already overlaps four durable copies. The export still stages one verified source, flushes every copy, then reads and compresses each copy into the ZIP. A fresh publication uses a directory rename. Existing-publication revalidation does not explain this fresh-fixture case.

Same-repository CI moved to self-hosted runners in PR #601. This history is a lead, not proof that the runner change caused the timeout. The failed log has no storage-latency or host-contention measurements. Strix triage confirmed the timeout; its suggested deterministic bottleneck and timeout increase are not supported by that log.

## Run the diagnostic

Use Node 22.23.3 and the installed web dependencies. From the repository root, run:

```sh
node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs \
  web/scripts/diagnose-accepted-stl-export.mts \
  --scratch-parent /path/to/existing/scratch/parent
```

The default fixture exports 10,001 copies of the same 12-byte `accepted-stl` payload as the regression. `--units` accepts integers from 1 through 10,001 for smaller probes. The script creates and removes its own unique directory beneath the chosen parent. It does not load a database, server configuration, or an existing plan.

The JSON report contains export wall time and process CPU time, filesystem type, real `fsync` callback counts and latency, maximum outstanding flushes, and ZIP source stream counts. It verifies every loose file and every decompressed ZIP entry, the complete filename inventory, ZIP digest, and publication key. Failure or failed cleanup exits nonzero.

Setup, dynamic import, output validation, and cleanup are outside the measured export call. The copy phase ends at the first ZIP-source stream creation. The remaining phase includes ZIP creation, its final hash, and publication. Callback latency includes worker-pool queueing and event-loop delay. Summed callback latencies overlap and are not wall time. Passive wrappers add unquantified overhead. This is a standalone measurement, not a pass of the 60-second regression.

## Local reproduction

VM136 has 12 logical CPUs. Its default `TMPDIR` is `/persist/tmp`, on persistent storage. Explicit `/tmp` uses tmpfs. All fixtures were temporary.

The unchanged 10,001-unit regression timed out at 60,000 ms with the VM's default Node 24.21.0 and persistent storage. With CI's Node 22.23.3, two separate persistent-storage runs passed in 44.21 s and 29.46 s. One explicit-tmpfs run passed in 13.34 s. These individual observations are not a Node-version comparison or an optimization result.

The full, unchanged accepted-STL suite passed all 27 tests on persistent storage with Node 22.23.3. An earlier tmpfs suite passed 26 tests but returned `output_failure` in the separate large-byte case. That failure was not diagnosed by this slice. Tmpfs is not proposed as a CI workaround.

## Repeated diagnostic evidence

[The recorded samples](accepted-stl-export-local.json) alternate tmpfs and persistent storage five times, with a fresh process and fixture each time. No exporter code or settings change between samples. The VM was shared with unrelated work, including filesystem scans, type checking, and linting. Load and I/O-pressure snapshots accompany each run. These measurements compare storage environments, not exporter implementations.

- Tmpfs export wall time had a median of 12.298 s, with a range of 11.436 to 13.416 s. The copy phase had a median of 3.830 s. The ZIP-through-publication phase had a median of 8.825 s.
- Persistent-storage export wall time had a median of 26.958 s, with a range of 21.299 to 47.389 s. The copy phase had a median of 14.157 s. The ZIP-through-publication phase had a median of 9.476 s.
- Each run observed 10,003 successful real flush callbacks, at most four outstanding, and no flush or ZIP-source errors. Mean callback latency per run was 0.111 to 0.137 ms on tmpfs and 2.755 to 10.688 ms on persistent storage.
- Each run consumed 10,001 ZIP sources and verified 120,012 bytes in loose files and again after decompression. All scratch directories were removed. Every ZIP had SHA-256 `ac19fd178c189efa81d0d376f8b0e7e607e7a636dab6c07b48b262470a1345b8`. Every publication was `content-580e80ee5db90aaefc15440a6557d816661dea61823110adb0f00b73e74a3d3f`.

The local storage-dependent cost is concentrated in durable copies. The longer copy phase accompanies longer flush callbacks, while ZIP-phase ranges overlap. Callback measurements cannot separate device latency, worker-pool queueing, and event-loop delay. This evidence supports investigating storage and contention first. It does not prove the cause of the original CI timeout, and none of the repeated Node 22 diagnostic runs exceeded 60 seconds.

A separate 1,000-unit `strace -f -c` run confirmed 1,002 successful `fsync` syscalls, matching source, copy, and ZIP flush accounting. Its output validation and cleanup passed. The traced run is excluded from timing comparisons because tracing adds overhead.

## Next slice

Run the diagnostic on the affected runner class with temporary fixtures, preserving its filesystem and runtime. Record CPU quota, host I/O pressure, worker-pool settings, competing jobs, and the diagnostic output. Compare repeated quiet and contended runs before choosing a fix. The current evidence does not distinguish slow storage from host contention on the original runner.

Keep the 10,001-unit regression and its deadline, durable flushes, artifact verification, quota accounting, and publication identity. A production fix needs its own review and same-head export regressions and full applicable CI. Coordinate recovery for #783 through evidence and comments after that reviewed fix exists. Its API-key regeneration slice is outside GRE-928.
