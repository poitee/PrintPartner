# CanonicalTarget fuzzing

This standalone cargo-fuzz crate is excluded from the Rust workspace, so ordinary
workspace builds, tests and nextest runs do not compile libFuzzer. It only parses
in-memory URI bytes; it never opens a socket or contacts a printer.

Install `cargo-fuzz` and a nightly Rust toolchain, then run from `rust/`:

```sh
cargo +nightly fuzz run canonical_target -- -max_total_time=60 -max_len=4096
```

Successful parses must preserve the query, remain origin-form, have safe decoded
segments and be idempotent. URI/parser rejections are expected. Crashes and corpus
mutations are ignored by Git; retain minimized reproducers as regression tests.
The independent `Cargo.lock` pins the fuzz dependency graph.
