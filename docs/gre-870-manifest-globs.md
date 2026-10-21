# GRE-870 manifest glob parity

`fixtures/parity/manifest-globs/generate.mjs` extracts the current Node
`matchKeyMatches` and `globToRegExp` functions from
`web/apps/server/src/services/manifest-apply.ts`. It uses
`stripTypeScriptTypes` and `runInNewContext`, following the existing
`rust/crates/pp-storage/tests/fixtures/manifest-globs-node.mjs` generator.

The `ManifestGlobMatrix` fixture in `node.json` contains a `domain`, ordered
`patterns` and `keys`, and boolean `expected` rows. Each row records Node's
answer for one pattern against every key. The bounded Cartesian domain uses
all strings of length zero through two over `a`, emoji U+1F600, LF, CR,
U+2028, and U+2029. Patterns also include `?` and `*`. Length counts alphabet
symbols, while Node wildcard matching consumes UTF-16 units. The fixed
`probe-` prefix and `-end.stl` suffix keep terminators internal and make every
key eligible for STL preparation.

There are 73 bounded patterns and 43 bounded keys. Supplemental patterns and
keys cover long s, dotless i, Kelvin sign, sharp s, sigma, dotted I, Deseret,
and repeated stars. The full Cartesian matrix has 102 patterns and 55 keys,
with 5,610 outcomes: 264 accepts and 5,346 rejects. Literal accept and reject
anchors guard both the generator and the Rust test. The generator also checks
that `?` rejects an emoji and `??` accepts it.

`public_preparation_matches_node_matrix` exercises
`WriterOwner::working_drafts_with_observations` and public `recompute` with
fake `DraftReads`. It runs one recompute per pattern against the entire key
set, with a unique idempotency key for each row. A single manifest rule marks
matches `optional`; unmatched keys must return JSON `null` for `requirement`.
The test checks every key's exact requirement, inventory size, and uniqueness.
A `*` fallback would reject internal line terminators, so the test uses absent
requirement metadata to observe rejection.

`committed_matrix_matches_current_node` runs the generator with `--check` from
the Rust test suite. CI supplies its pinned Node 22 executable through
`PP_SCHEMA_PARITY_NODE`; local runs otherwise use `node` from PATH. The check
rejects stale fixture output when the Node matcher or bounded domain changes.
The test copies `unchanged.db` into a disposable directory and clears its
imported-path filter there. It supplies inventory, manifests, and artifact
bytes in memory. Cleanup attempts both owner shutdown and disposable directory
removal, including SQLite sidecars. Cleanup errors fail a passing test or print
diagnostics during assertion unwind without a second panic.
Regenerate or check with Node 22:

```sh
node fixtures/parity/manifest-globs/generate.mjs
node fixtures/parity/manifest-globs/generate.mjs --check
```

Run the focused test with three build jobs. In the fleet environment, use the
installed two-slot cargo semaphore wrapper and shared sccache configuration:

```sh
CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml \
  -p pp-storage --features desktop_rebuild --test manifest_glob_parity -- --nocapture
```

The integration test is gated by the default-off `desktop_rebuild` feature.

To verify mutation detection, change only `expected[9][7]` in `node.json`
from `true` to `false`. Run the focused Rust test and confirm that
`public_preparation_matches_node_matrix` fails at row 9, column 7, for
literal pattern and key `probe-aa-end.stl`. The assertion must report actual
`Some(String("optional"))` against expected `Some(Null)`.
Restore the fixture, then rerun the Node `--check` and focused Rust test.

## Segment-search digests (GRE-748)

`rust/crates/pp-storage/tests/fixtures/manifest-segments-node.mjs` runs Node
`matchKeyMatches` over the three generated families that the segment-search
unit tests in `manifest_glob_tests.rs` use. It records each family's accept
count and FNV-1a digest in `manifest-segments-node.json`, and the Rust tests
compare against that file.

- `exhaustive`: every pattern up to 5 units over `a`, `b`, LF, `?` and `*`,
  against every key up to 6 units over `a`, `b` and LF.
- `longKeys`: 4,000 seeded keys up to 399 units. Half of them space stars far
  enough apart that segments take the NTT search.
- `longMasked`: 1,000 patterns of the form `*` + masked segment + `*`, where
  the segment has at least 65 units, so every case takes the NTT search.

Each pattern and key is wrapped in `x`, which makes trimming, lowercasing and
the basename fallback no-ops. The recorded outcome is then Node's `^pattern$`
answer on the raw units. Desktop Contracts runs the generator with `--check`.
