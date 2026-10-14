# GRE-353 native-process receipt design judge

Reviewer: Grok Build. Both designs are Codex's. This compares only the strict receipt check for `rust/scripts/native-process-probe.py`. No repository edits, self-test, or native process run were part of this review. No merge score.

## Recommendation

Use the explicit predicate in `design-explicit.md` as the base. In `validate`, require `close_hid` and `show_visible` to be `True`, require these five shutdown fields to be `True`, and require `errors == []`:

`compat_reaped`, `storage_released`, `gateway_stopped`, `marker_removed`, `runtime_removed`.

Keep the existing filesystem check for `.desktop-owner.json`. Graft the operational constraints below from `design-table.md`. Leave `REQUIRED_SHUTDOWN_FLAGS` out of the script. The self-test must pin those five names itself.

## Rubric

| Criterion | Explicit (`design-explicit.md`) | Tuple (`design-table.md`) |
| --- | --- | --- |
| Five shutdown booleans | Pass. All five appear in the assertion as `is True`. | Pass when the tuple's five entries are complete. |
| Two native-window booleans | Pass. `close_hid` and `show_visible` stay `is True` on the window record. | Pass. Same predicate, kept outside the tuple. |
| Fail-closed missing and malformed JSON | Pass. `.get()` plus `is True` plus `errors == []`. The test matrix includes `0`. | Predicate passes. The published matrix omits `0`. A short tuple still has a green self-test. |
| Smallest diff | Pass. Replaces the existing assertion. No new name. | Weaker. Adds a constant and a second place to read. |
| Independent negatives and a real native positive | Pass when the test pins the five keys, as that design requires. | Fail. The positive fixture and the mutation loop are built from the tuple. |
| No scope escape | Pass. One script. The wider how-note stays out. | Weaker. An optional second Python test is left open. The rest of the boundary matches. |

## Why the explicit predicate is the base

`validate` today is truthy on `compat_reaped`, `storage_released`, and `gateway_stopped`, truthy on both window fields, and uses `not receipt['errors']`. The self-test fixture has no cleanup flags, and `for key in receipt` never changes them. False `marker_removed` and `runtime_removed` therefore pass, which matches the read-only check recorded in `/tmp/gre353-how.md`. `ShutdownReceipt` already serializes all five flags. `complete()` still ignores the two cleanup flags; Core derives `storage_released` from marker cleanup, runtime cleanup, and lock release. This slice is a Python verifier omission.

The explicit assertion writes the five names at the boundary `validate` already has. A missing JSON field becomes `None`, and `None is True` fails in the same assertion as `False`. Integer `1`, `"true"`, `[True]`, and `{"ok": True}` fail. `errors == []` rejects a missing field, `None`, `False`, `""`, `{}`, and a nonempty list. Unknown fields stay allowed. The marker-file assertion still fails when every receipt flag is true.

Callers, the CLI, the return pair, JSON-line selection, and the launch command stay as they are. There is no new module, helper, or schema object.

## Why the tuple is not the base

With those five strings present, `all(receipt.get(key) is True for key in REQUIRED_SHUTDOWN_FLAGS)` accepts and rejects the same shutdown values. The loss is the test plan in `design-table.md`: validation and self-test fixture generation consume the tuple, and the positive shutdown fixture is built from it. That design also says a flag omitted from the tuple is invisible to those tests, and leaves detection to a review against Core.

That is the hole this slice exists to close. A tuple that drops `marker_removed` and `runtime_removed` recreates today's passing self-test. The checker does not require them, the generated fixture does not contain them, and the negative loop does not delete them.

A positive fixture of all-true values cannot see an ignored field on its own. `validate` returns the parsed dict, and extra fields stay allowed, so `check() == (receipt, window)` passes when those cleanup flags are true and unread. The omission shows up when a negative control deletes the key or replaces it, and that control's names are a different list from the one production iterates.

The hand-written repetition is the control for a fixed five-field contract. One shared list removes that control. A second production consumer would be the reason to reopen the tuple. This script has one checker.

## Tests that pin the contract

Write the positive shutdown dict in `self_test` as a literal with `compat_reaped`, `storage_released`, `gateway_stopped`, `marker_removed`, and `runtime_removed` all `True`, and `errors` set to `[]`. Build that dict in the test. Do not derive it from a production tuple, from `receipt.keys()`, or by reading the assertion.

Drive the shutdown negatives from a second literal of those same five names in the test. For each name, on a fresh copy, reject omission, `False`, `None`, `0`, `1`, `"true"`, `[True]`, and `{"ok": True}`. Keep `0`. It is the falsy non-boolean. `1` is the truthy non-boolean the current checker accepts. Capture loop variables in lambdas.

Pin `close_hid` and `show_visible` the same way: omission and that same set of values. Keep the nonzero-exit control.

For `errors`, reject a missing key, a nonempty list, `None`, `False`, `""`, and `{}`. The valid `[]` fixture must pass.

Keep the surviving `.desktop-owner.json` control with all five flags true and `errors` empty. Run every negative through the existing rejection runner so it expects `AssertionError` from `check`. Each flag case uses otherwise valid evidence and no marker file.

Replace the hardcoded "8 rejected failures" sentence with the number of controls that run actually executed, including the marker control. Compute that count from the cases just run. Do not compute it from a production flag tuple.

## Grafts from the tuple design

Take these, and leave the tuple itself out:

- Reject `== True`, `bool(value)`, and a default of `True`. Use `is True` and `== []`.
- Keep the two window fields on their own assertion. They belong to the native-window record.
- Keep the filesystem marker check. `marker_removed` does not replace it.
- Missing debug binary, measured stage, or WebKit SDK, after the existing build and stage tooling, is unfinished acceptance evidence. The self-test does not close the slice.

## Real positive

After `python3 rust/scripts/native-process-probe.py --self-test` passes, run the existing probe. Ordinary `python3` only; `python3 -O` strips the assertions. The debug `pp-desktop` must accept the probe's `--test-exit-seconds`. Use its matching measured stage and the extracted Linux GTK/WebKit SDK. Write the receipt to `/persist/home/.local/state/pstack-t3/gre353-next/native-process-positive.json`.

Inspect that file and the stdout and stderr written beside it. Required observations: process exit zero, both window flags exactly true, all five shutdown flags exactly true, `errors` equal to `[]`, and acceptance by the changed `validate` before the script writes the receipt. The proof class stays `native_linux_unsigned_process`, with `rendered_ui` false and `macos` false. Close/show automation supports the window flags only. Tray actions and rendered React content stay outside this claim. An old receipt or a synthetic fixture does not meet this step.

## Scope

Edit `rust/scripts/native-process-probe.py` only. Leave out a second test module, a schema helper, and a table of predicates. Leave Rust receipt construction, `complete()`, and the recovery probe alone. The recovery probe's truthy check over the same five names is a different verifier.

Leave the wider work in `/tmp/gre353-how.md` unstarted: proof-class policy, source and binary hashes, runtime and socket absence, re-locking `.desktop.lock`, and the popup probe. No UI, workflow, D-slice, or GRE-402 edits.

## Checked

- `design-explicit.md` chooses the in-place assertion and an independent positive fixture.
- `design-table.md` chooses `REQUIRED_SHUTDOWN_FLAGS` and builds the positive fixture from that tuple.
- `/tmp/gre353-how.md` describes the wider native-acceptance slice this comparison leaves out.
- Live `validate` and `self_test` in `rust/scripts/native-process-probe.py`.
- `ShutdownReceipt` and `complete()` in `rust/crates/pp-core/src/lib.rs`.

This review did not change the repository and does not claim a native run.
