# GRE-353 verifier implementation result

Implemented the selected explicit-predicate design in `rust/scripts/native-process-probe.py` on branch `owner/gre353-next-202610140800-a1c4`.

The validator requires both native-window flags and all five shutdown flags to be exactly `True`. It requires `errors == []`. Missing required fields raise `AssertionError`. The independent `.desktop-owner.json` absence assertion remains. Signatures, JSON parsing, CLI parsing, and the live-launch wrapper remain unchanged.

The self-test independently pins the complete shutdown dictionary and the five mutation keys. Each shutdown and window field has eight rejection controls, including omission and malformed JSON values. Errors has six rejection controls. The nonzero-exit and surviving-marker controls remain. All 64 negatives call the real validator and require `AssertionError`; the runner does not catch `KeyError`.

The repository diff contains one file, with 29 added lines and 8 deleted lines. The resulting script has 129 lines. `git diff --check` passed. No comments were added.

## Red evidence

[code-red.log](/persist/home/.local/state/pstack-t3/gre353-next/code-red.log) records the self-test run before the validator changed. It exited 1 as intended because the old validator accepted `close_hid=1`. The rejection runner raised `AssertionError` with `Invalid native process evidence was accepted`.

## Green evidence

[code-green.log](/persist/home/.local/state/pstack-t3/gre353-next/code-green.log) records the post-fix self-test success with a valid receipt and 64 rejected failures. The self-test and `py_compile` both exited 0 under `land.py slot --`. Python bytecode was redirected outside the repository.

## Principles applied

Model the Domain retained the two existing evidence dictionaries. Laziness Protocol kept the acceptance policy in explicit in-place assertions. Test Behavior, Not Implementation kept the literal fixture and test mutation names independent of production predicates. Prove It Works required execution of the actual validator through the built-in self-test and inspection of the final diff.

## Remaining acceptance work

The parent owns the fresh real direct native launch and the independent Grok Build review. This implementation did not run Rust builds or launch the native process. The known SDK-wrapper limitation remains outside the change. No native acceptance or merge-readiness claim is made. No children, commits, pushes, PRs, or merges were created.
