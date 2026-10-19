# Inspected work in option-group merges

`working_drafts::manifest::merge_with` charges the entries each lookup inspects.
Previously, it charged the full candidate vector even when the first entry matched.
Repeated early matches could exhaust a preparation grant that covered the actual work.

Group lookup, incoming variant lookup, prior variant deduplication, and path union
now use the first matching position. A match at index `i` costs `i + 1`, including
the matching entry. A missing match costs the vector length. An empty lookup costs
zero comparison work but still calls the charge callback once.

Each lookup finishes its search, calls the existing `FnMut(usize)` callback once,
and then updates the target. This preserves callback and visit counts. Budget
cancellation still checks once for the visit and once for the comparison charge.
A refused merge can leave partial changes, as before. Callers must discard the
preparation after refusal.

The final sort retains its separate charge of the resulting group count, even
when there are no incoming groups. Numeric group keys still sort first. Other
keys retain their insertion order. Variant deduplication retains the first
position and the last prior value. Existing group metadata and nonempty variant
labels keep their precedence, while path unions retain the first occurrence.

The same-file `inspected_merge_tests` check early, late, missing, and empty
lookups. Each fixture records the exact callback sequence. Tests check exact
comparison and visit grants, one-unit-under refusals for positive grants, and
cancellation at every callback boundary. Separate assertions cover final sorting,
metadata precedence, variant replacement, and stable path deduplication.

The lookup remains linear and uses the existing vectors. No preparation limits,
feature gates, runtime gates, or activation flags change.

Run the focused checks from `rust`.

```sh
CARGO_BUILD_JOBS=3 cargo test -p pp-storage --features desktop_rebuild --lib inspected_merge_tests
CARGO_BUILD_JOBS=3 cargo test -p pp-storage --features desktop_rebuild --lib working_drafts
```
