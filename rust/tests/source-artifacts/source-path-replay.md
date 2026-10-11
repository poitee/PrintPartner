# SourcePath property corpus and Node replay

Build the Node snapshot module using the source-artifacts CI job's commands,
then run from the repository root with the pinned Node 24.21.0:

```sh
cargo nextest run --manifest-path rust/Cargo.toml --locked -p pp-source
node --test rust/tests/source-artifacts/source-path-replay.test.mjs
cargo run --manifest-path rust/Cargo.toml --locked -q -p pp-source --example source_path_corpus > corpus.json
node rust/tests/source-artifacts/source-path-replay.mjs web/apps/server/dist/current/services/local-source-snapshot.js corpus.json report.json
```

The corpus combines fixtures with 20,000 deterministic proptest inputs. The
example accepts `--cases N` and `--seed HEX64`. Rust's actual parser decision,
NFC spelling, and Unicode version accompany each input. Rust strings contain
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
- The exact `a\u1ADD\u0300` to `\u00E0\u1ADD` NFC reordering, with Rust Unicode
  16.0.0 and Node Unicode 17.0: also GRE-555. Other NFC differences fail.

`unexpectedMismatches` counts cases with new differences or a parser decision
that violates its independent contract model. A Rust-only exception cannot
excuse a shared NFC or structural rejection. NFC differences are checked even
when both parsers reject for other reasons. A nonzero unexpected count makes
the CLI exit 1. The regression tests exercise the original masking failure,
unknown Unicode drift, complete evidence retention, and the CLI failure path.

Known differences make **zero total mismatches unattainable until GRE-555 is
resolved**. Report the raw and unexpected counts separately; do not describe a
successful replay exit as full Rust/Node parity.
