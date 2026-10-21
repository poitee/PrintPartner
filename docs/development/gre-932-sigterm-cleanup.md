# GRE-932 SIGTERM cleanup race

`run_in_subreaper` sends one timeout SIGTERM through `worker.terminate()`.
If that signal arrives after the callback finishes but before the worker installs `SIG_IGN`, the timeout handler raises and could skip descendant cleanup.
This affects callback success, `AssertionError`, and other exceptions.

The callback's existing `finally` now installs `SIG_IGN` inside a `try` whose `finally` reaps descendants and writes the cleanup receipt.
Cleanup therefore runs even if the parent's timeout SIGTERM interrupts that installation.
The outcome and receipt formats stay unchanged.
Arbitrary repeated external signals are outside this fix's scope.
Signal masking was rejected because descendants inherit the mask and masking does not close the transition gap.

The regression pauses the worker before `SIG_IGN` and lets the real parent timeout send SIGTERM for all three callback outcomes.
An outer subreaper contains leaked descendants if the regression fails.
The suite retains the five existing baseline tests alongside that regression.
The Linux verification commands, run from the repository root, are:

```sh
python3 rust/tests/test_built_backend_cleanup.py -v
git diff --check
```

The expected result is six passing tests, including all three regression subcases.
After [PR #796](https://github.com/poitee/PrintPartner/pull/796), add this Python suite to the appropriate Linux CI job as a separate follow-up.
This fix does not change CI workflows.
