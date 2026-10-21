# Preparation quantity regexes

Draft preparation compiles each captured layer's quantity regex once, when
`capture` builds the layer. It also derives that layer's slug strip regex once.
The five constant transforms that turn the quantity regex into the strip pattern
run at that point, not for every scanned path. Every path in the layer then
reuses the compiled regexes. The compiled regexes live on the captured layer and
are dropped with the capture. No cache is shared across layers, profiles or
preparation attempts.

Parsing is unchanged. A quantity regex that does not compile still fails when the
first path is parsed, not during capture. A strip pattern that does not compile
still leaves the slug unchanged. The per-path `comparison_work` charges for
quantity matching and slug stripping are unchanged. Compiling at capture adds no
new budget charge.

The code remains inside the default-off `desktop_rebuild` module. Product callers
also require the startup `DesktopRebuild` value captured from `PP_DESKTOP_REBUILD`.
The internal storage client does not activate that product gate.

The public-client tests call `WriterOwner`'s working-draft client with a disposable
database and synthetic observations:

- `preparation_quantity_regexes_are_profile_scoped` attaches a second Source whose
  naming override replaces the default `x` quantity regex with `q`. Each layer
  infers quantities and detects slug conflicts with its own regex.
- `preparation_quantity_output_is_unchanged` pins the parts produced before this
  change: signs, zero, trailing letters, unmatched names, and a strip conflict.
  It also pins the existing refusal for a capture that is not a number. That
  refusal preserves all five draft tables and the source-file bytes.

Both tests passed against the parser before the change, and they pass after it.
The unit test `preparation_matches_literal_node_results` still matches the Node
fixture. It also checks that its two-layer, seven-path case compiles the regexes
twice, once for each layer.

Use the fleet Cargo semaphore wrapper with three build jobs and shared sccache.

```sh
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild preparation
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets -- -D warnings
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
cargo test --manifest-path rust/Cargo.toml -p pp-storage
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild
```
