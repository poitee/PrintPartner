# Comment Sicko

Scope: added comments and docstrings in `git diff HEAD -- rust/tests/webkit_stl_smoke.py` at `/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610140800-a1c4`. Existing comments left alone. No application logic edits.

## Touched files

- `rust/tests/webkit_stl_smoke.py`

## Deletion count

1

Deleted the docstring on `frame_denial`:

```python
"""Return one failure for a completed attempt, or None for proven denial."""
```

Private test helper in this smoke script. The returns already say the same thing (`invalid_frame_attempt`, `parent_not_preserved`, `target_executed`, `native_csp_enforcement_unproven`, `csp_enforcement_unproven`, `unexpected_child_document_get`, or `None`). Not a public API contract.

## MUST KILL

None. The docstring restated the returns. It did not paper over a surprise that needs a rename, extract, type, or rearchitecture.

## Skips

None. No added comment met a keep clause.

Not comments, so not judged: the three added `"""` script bodies passed to WebDriver (`observe` preflight fetch, iframe install, and sample loop). They are executable JavaScript string literals. No `#` comments, lint suppressions, or issue links were added.
