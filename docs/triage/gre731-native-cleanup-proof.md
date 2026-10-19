# GRE-731 native macOS cleanup proof

## Tested revision

Current `origin/main` was `438cee982f0ef20ac0db67e4bd97c9b1ad60f544` on 2026-10-19. It contains the cleanup change from [PR #588](https://github.com/poitee/PrintPartner/pull/588), merged as `515d0b333115473d899be22984d9070dca11e137`.

Manual dispatches of [Native macOS bundle](https://github.com/poitee/PrintPartner/actions/runs/39317059432) and [Rust cross-OS](https://github.com/poitee/PrintPartner/actions/runs/39317064342) both target that exact main revision.

## Cleanup behavior

The [manually dispatched native storage job](https://github.com/poitee/PrintPartner/actions/runs/39317059432/job/118281771636) records these exact output lines:

```text
2026-10-19T20:12:09.4873690Z test_busy_image_records_holder_before_force (__main__.CleanupTest.test_busy_image_records_holder_before_force) ... ok
2026-10-19T20:12:10.2293690Z test_cleanup_errors_preserve_successful_test_status (__main__.CleanupTest.test_cleanup_errors_preserve_successful_test_status) ... ok
2026-10-19T20:12:29.2839370Z test_native_busy_image_reports_real_holder_before_force (__main__.CleanupTest.test_native_busy_image_reports_real_holder_before_force) ... ok
2026-10-19T20:12:30.2407400Z test_normal_detach_never_lists_holders_or_forces (__main__.CleanupTest.test_normal_detach_never_lists_holders_or_forces) ... ok
2026-10-19T20:12:30.2409870Z Ran 5 tests in 21.289s
2026-10-19T20:14:52.8477580Z      Summary [ 101.614s] 99 tests run: 99 passed (1 slow), 0 skipped
2026-10-19T20:14:53.0742850Z "disk7" ejected.
```

GitHub reports both `Test owned image cleanup and native holder reporting` and `Verify source Unicode and case regressions on macOS` as `success`.

The regression script extracts the production workflow shell. Its native case uses real APFS, `hdiutil`, `lsof`, and a process holding an open fixture file. It asserts three ordinary detach attempts, two sleeps, holder reporting before forced detach, preservation of test exit 23, and an unmounted fixture afterward.

The other cases run on the same macOS host with simulated tool outcomes. They check successful ordinary detach on attempts 1, 2, and 3, preservation of test exit 23 despite cleanup errors, and successful exit 0 despite exhausted detach attempts. The exhausted-cleanup case asserts this exact warning template:

```text
::warning::Could not detach owned test fixture at {mount}
```

The subprocess output and call trace are captured by the tests, so their successful assertions are the evidence for retry order and warning text. The outer job log prints test names and outcomes. No real forced-detach failure or actual warning from the 99-test step is claimed.

The overall job fails later in `Verify macOS identity and core-death storage gate`, with this separate test failure:

```text
test origin_tests::ticket_t_12_origin_cleanup_removes_only_owned_regular_temporary_files ... FAILED
```

That later failure does not change the successful source step's result.

## Cross-OS sparse image

The [manually dispatched cross-OS macOS job](https://github.com/poitee/PrintPartner/actions/runs/39317064342/job/118281245907) also reports `Mount a short case-sensitive TMPDIR` as `success`. Its later workspace checks were still running when this evidence was collected. The exact attachment output below comes from the earlier completed run of the same revision.

The [cross-OS macOS job at the same main revision](https://github.com/poitee/PrintPartner/actions/runs/39305708197/job/118242200923) reports `Mount a short case-sensitive TMPDIR` as `success` and logs:

```text
2026-10-19T18:50:58.9461680Z created: /Users/runner/work/_temp/pptmp.sparseimage
2026-10-19T18:51:00.9864650Z /dev/disk8s1        	41504653-0000-11AA-AA11-0030654	/Volumes/pptmp
```

`rust-cross-os.yml` creates and attaches its sparse image in one step, then shares `/Volumes/pptmp/tmp` with later steps through `GITHUB_ENV`. It has no `hdiutil detach` or `EXIT` trap. The cleanup-status replacement from GRE-731 does not apply to this workflow. Later nextest failures in that run do not come from image attachment or detachment.

## Replay and scope

After the whole workflow completes, the native job log can be downloaded with:

```sh
gh run view 39317059432 --job 118281771636 --log
```

`python3 scripts/test_native_image_cleanup.py -v` passed on Linux with four tests passing and the native APFS case explicitly skipped. This local replay supplements the macOS evidence.

This closeout adds only this evidence document. The workflow and regression script remain owned by open PRs [#727](https://github.com/poitee/PrintPartner/pull/727) and [#734](https://github.com/poitee/PrintPartner/pull/734). GRE-732 retains optional diagnostic and holder-lifetime follow-ups.
