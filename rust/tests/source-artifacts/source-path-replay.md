# SourcePath property corpus and Node replay

Build the Node snapshot module using the source-artifacts CI job's commands,
then run from the repository root with the pinned Node 24.21.0:

```sh
cargo nextest run --manifest-path rust/Cargo.toml --locked -p pp-source
cargo run --manifest-path rust/Cargo.toml --locked -q -p pp-source --example source_path_corpus > corpus.json
node --test rust/tests/source-artifacts/source-path-replay.test.mjs
node rust/tests/source-artifacts/source-path-replay.mjs web/apps/server/dist/current/services/local-source-snapshot.js corpus.json report.json
```

The corpus combines 54 path fixtures, 408 Unicode version probes, and 20,000 deterministic proptest inputs. The
example accepts `--cases N` and `--seed HEX64`. Rust's actual parser decision, independent reference verdict, NFC spelling,
and Unicode version accompany each input. A verdict/reference disagreement is
emitted rather than panicking, so replay can retain both runtime decisions
before failing. Rust strings contain
Unicode scalar values; Node-only lone UTF-16 surrogates are outside this corpus.
The fixtures include the rejection table from the existing read-only Node
`local-source-snapshot.test.ts`, as well as boundary and Unicode cases.

The report's `mismatches` is the **raw accept/reject count**. It is not reduced
by the known-difference classification. All exact paths, both decisions,
shared-contract decisions, normalized spellings, origins, classifications, and
follow-up links are retained. CI uploads both the corpus and report.

Known differences are explicit:

- Rust's documented 4,096 UTF-8 byte and 64-component bounds.
- Colon rejection and the manifest name as the first directory component:
  tracked in [GRE-555](https://linear.app/greetz/issue/GRE-555/sourcepath-parity-align-rust-and-node-nfc-versions-and-colon).
  Node rejects the reserved directory later at materialization.
- Exact full-string transformations from `source-path-unicode-16-17.json`,
  with Rust Unicode 16.0.0 and Node Unicode 17.0: also GRE-555. These include
  U+1ADD, U+1AE6, U+1AEB, and the other new combining-class characters.
  Effects outside the confirmed transformations fail independently.

`unexpectedMismatches` counts cases with new differences or a parser decision
that violates its independent contract model. A Rust-only exception cannot
excuse a shared NFC or structural rejection. NFC differences are checked even
when both parsers reject for other reasons. A nonzero unexpected count makes
the CLI exit 1. The regression tests exercise the original masking failure, unknown Unicode
drift, complete evidence retention, and CLI failure paths. They also invoke the
real corpus producer with `--cases 0 --test-reject part.stl`: this explicitly
labeled fault injection preserves the reference verdict and proves replay writes
Node/Rust evidence before exiting 1. Build the example before running those
tests. `PP_SOURCE_PATH_CORPUS_BINARY` can select an alternate target directory.

Known differences make **zero total mismatches unattainable until GRE-555 is
resolved**. Report the raw and unexpected counts separately; do not describe a
successful replay exit as full Rust/Node parity.

The expanded Unicode fixtures were derived by comparing the official
[Unicode 16 data](https://www.unicode.org/Public/16.0.0/ucd/UnicodeData.txt) and
[Unicode 17 data](https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt). The
34 new nonzero-combining-class marks are U+1ACF..U+1ADD, U+1AE0..U+1AEB,
U+10EFA, U+10EFB, U+1E6E3, U+1E6E6, U+1E6EE, U+1E6EF, U+1E6F5. No new
canonical decomposition mapping occurs in this version pair. Each mark is
paired with U+0300, U+0301, U+0302, U+0323, U+031B, and U+0315 in both orders
on a Latin `a` stem. All 408 raw paths were checked against the actual Rust and
Node validators and normalizers; 113 differ. Generation adds valid directory
prefixes and optional colons. This targets the version delta while the broader
strategies continue exploring arbitrary scalar strings and other path rules.
