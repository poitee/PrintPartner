# Accepted STL export timeout diagnosis

GRE-928 remains open. The diagnostic on self-hosted PR runners showed the 10,001-unit copy phase never reached the ZIP. Identical copies now share the verified inode, and the directories that hold those names are flushed before publication.

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

## CI attribution after #817

The diagnostic in #817 is standalone. Neither the workflow nor the regression invokes it. The first post-merge [main Web CI run 39338862507](https://github.com/poitee/PrintPartner/actions/runs/39338862507) passed all 27 export tests. The 10,001-unit case took 7,296 ms on a hosted runner. Its log contains no copy/ZIP phase measurements. Pull-request web jobs use self-hosted `pp-local` runners, while main push jobs use `ubuntu-latest`. A passing hosted run cannot attribute the reported self-hosted timeout.

The 10,001-unit regression writes directly to stdout so passing-test console suppression cannot hide the records. It emits JSON prefixed with `GRE-928 accepted-STL diagnostic` at start, every 15 seconds, and from `afterEach`. It reuses the existing filesystem mock wrappers and still calls the real filesystem. Only that test activates the counters. The final event is named `test-ended`, including after failure or timeout. It records whether the export returned, threw, or was still running when cleanup began. It does not certify success. Vitest's result and the unchanged 60,000 ms deadline remain authoritative.

The records include source/copy flush calls, callback errors, outstanding flushes, latency totals and maximum, and staged ZIP-source starts, consumed ends, errors and bytes. The source/copy flush wrapper does not observe the ZIP output stream's internal flush. Before the inode fix, a successful fixture observed 10,002 wrapped flush callbacks. The regression now expects the verified inode flush plus the directory flushes for this layout, which is 5, and still expects 10,001 consumed ZIP sources. The test asserts these counts and the consumed byte count. The standalone diagnostic remains the check for the ZIP output flush and full byte/publication identity.

The first staged STL read-stream creation separates the copy phase from ZIP-through-publication. Progress before that boundary has null ZIP times. A stalled copy has outstanding flush/latency evidence; a stalled ZIP has source/byte progress. Callback latency includes worker-pool queueing and event-loop delay, so it cannot isolate device latency. Summed callback latencies overlap. Timings include logging overhead, and the final snapshot includes the test's assertions before `afterEach`.

Runner name, run ID and attempt, Node version, worker-pool setting, whether TMPDIR is set, available parallelism, filesystem type, load average, event-loop delay, Linux CPU/I/O pressure, and cgroup CPU quota/stat files accompany each snapshot. Missing or unreadable Linux files produce null. For cgroup v2, the diagnostic resolves its own group from `/proc/self/cgroup` and records up to 16 ancestor quota/stat pairs beneath the conventional mount. Start/end CPU stats and pressure totals can be compared for throttling and stalls. Conventional v1 quota files are also read. Null CPU quotas do not establish an unlimited CPU allocation, because cgroup mounts and namespaces vary. These aggregate observations cannot identify individual competing jobs. The diagnostic reads only named runtime metadata and synthetic fixture storage; it never dumps environment variables, processes, plans, or credentials.

The instrumentation adds no second export to CI. A 15-second progress record can survive a later test timeout, but a blocked event loop or killed worker may prevent any final record. Those records are what the fix below uses. The historical sections describe the exporter before that change.

## Local regression instrumentation validation

[The bounded observations](accepted-stl-export-regression-observations.json) retain two Node 22 persistent-storage timeout snapshots from shared VM135. The first ran alongside the full quality suite. It spent 55.787 seconds before the first ZIP source. At the 60-second deadline, 10,002 wrapped source/copy flushes had completed without errors, and 875 ZIP sources had ended. A subsequent run after that quality process finished still timed out, spending 58.805 seconds before ZIP and consuming 587 sources by the deadline. Both suites passed the other 26 tests. These are censored snapshots of exports still running, not completed-export timings. The copy phase dominates these two local failures, but they do not isolate device latency from queueing or establish the original CI cause.

A fresh tmpfs scratch run passed all 27 regressions, including the large-byte case. This validates test behavior on that filesystem; it is not a CI storage workaround or an affected-runner pass. Vitest's minimal reporter suppressed the passing console records in that run. The diagnostic now writes directly to stdout so passing samples can be retained too. A focused run after that correction passed and retained start, progress and final `materialized` records, with 10,002 successful wrapped flush callbacks and 10,001 ZIP sources consuming all 120,012 bytes.

The first full local quality command reached 1,624 passing web tests and one unchanged UI test failure. That test's `findByRole` exceeded Testing Library's one-second wait while other work was running. The bounded follow-up uses Node 22, `VITEST_MAX_WORKERS=2`, and a fresh tmpfs `TMPDIR`, with no separately launched export process alongside the test suites. CI configuration and storage remain unchanged. These local resource controls must be named with any passing result.

## Fix

[Web CI run 39344143774](https://github.com/poitee/PrintPartner/actions/runs/39344143774/job/118372570864) on `pp-linux-5` wrote this fixture to overlayfs (`0x794c7630`). In 60 seconds the copy phase started 3,721 flushes, at most four at a time, and never opened a ZIP source. Callbacks averaged about 50 milliseconds, so 10,002 file flushes cannot finish inside the deadline. Libuv's default pool is four, which is the same cap as the old copy batch.

Each verified source is still written and flushed once. Further units are additional names for that inode. A filesystem that rejects the extra name falls back to a private flushed copy. After the names exist, the output directory and its parents in the stage are flushed, the temporary source name is removed, and the stage directory is flushed again. The ZIP still reads every published file. Quota accounting still charges each name's size. The 60-second deadline is unchanged.

## Next slice

Keep the 10,001-unit regression, its deadline, and publication identity. Recovery for #783 waits on this fix landing. Its API-key regeneration slice is outside GRE-928.
