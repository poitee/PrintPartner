# Run the stress-runner self-tests

From the repository root, run:

```sh
python3 rust/scripts/stress-group-cleanup.py --self-test
```

The self-test needs Python 3 and Unix `ps`. It creates disposable fake libtest
executables and needs no Rust build, desktop bundle, service, or plan data.
It checks scope routing, interleaved libtest output, inventory refusal, and
failure statuses through the runner executable. The self-test exits 0 on success
and 1 if a regression fails or no tests are found.

The normal runner still exits 1 for a failed child test or invalid result summary,
and 2 when a required test is missing or ignored. Refusal happens before evidence
logs are created.

The Desktop runtime workflow runs this command in its existing scripts self-test
step. Bash pipefail preserves a failure through `tee`, and the workflow uploads
`stress-group-cleanup-self-tests.log` with its runtime evidence even on failure.
