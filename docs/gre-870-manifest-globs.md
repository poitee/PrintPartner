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
The test copies `unchanged.db` into a disposable directory and clears its
imported-path filter there. It supplies inventory, manifests, and artifact
bytes in memory. The fixture owner shuts down and removes the disposable directory, including
SQLite sidecars, on completion or assertion failure.
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

The integration test is gated by `desktop_rebuild`.

Verification used Node v22.23.3. Regeneration with `--check` printed:

```text
102 patterns x 55 keys = 5610 Node matchKeyMatches outcomes verified (264 accept, 5346 reject)
```

The focused public test printed:

```text
public preparation: 102 patterns x 55 keys = 5610 outcomes verified (264 accept, 5346 reject)
test public_preparation_matches_node_matrix ... ok
```

Mutation verification changed only `expected[9][7]` from `true` to `false`,
for literal pattern `probe-aa-end.stl` against key `probe-aa-end.stl`.
The normal focused test exited 101 with:

```text
assertion `left == right` failed: Node parity row 9, column 7, pattern "probe-aa-end.stl", key "probe-aa-end.stl"
  left: Some(String("optional"))
 right: Some(Null)
```

After restoring the fixture, `--check` and the focused Rust test passed.
