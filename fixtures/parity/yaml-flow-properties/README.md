# YAML flow properties Node corpus

This standalone corpus records the six divergence families named in GRE-841 for GRE-871. It records Node outcomes only. It does not assert current Rust parser parity.

The 31 cases cover explicit empty flow keys, implicit empty flow keys, adjacent verbatim-tag text, a block colon after a flow collection, a multiline quoted flow key followed by a tab, and a comment immediately after a quoted key's colon. Controls distinguish a missing value from an empty mapping: `{"q":}` loads as `{"q":null}`, not `{}`. They also show that a space before the comment changes refusal into a one-key mapping with a null value.

`[? ]` decodes to `[{"null":null}]`. `[:[]]` decodes to `[{"null":[]}]`. js-yaml itself converts a YAML null mapping key to the string `"null"` in the JavaScript object it returns. The generator serializes that returned value unchanged.

Every seed has LF, CR, and CRLF variants. Seeds without internal line breaks also have an unterminated variant. Tabs remain literal bytes in the empty-key mapping and multiline-key cases.

`generate.mjs` resolves the repository's installed `js-yaml` through `web/apps/server/package.json` and calls `yaml.load(input)` with default options. `node.json` contains the exact input text, UTF-8 bytes as hex, package version, source metadata, and the full decoded JSON value or exact exception class and reason. These inputs decode to JSON values without a lossy conversion. The generator excludes timestamps, absolute paths, and Node patch versions so repeated runs produce identical bytes.

`verify.mjs` compares both the stored and freshly generated results with independent literal expectations. It then compares the complete stored file with the real Node run. Regenerating a changed result cannot update the verifier's expectations. Both scripts require Node 22 and js-yaml 5.4.3.

## Check the corpus

From the repository root, install the web dependencies with Node 22 and npm 10 or later if needed.

```sh
npm --prefix web ci
node fixtures/parity/yaml-flow-properties/generate.mjs --check
node fixtures/parity/yaml-flow-properties/verify.mjs
node fixtures/parity/yaml-flow-properties/verify.mjs --self-test
```

The verifier checks 31 cases, including 28 decoded values and 3 refusals. The self-test runs eight CLI tests. One accepts the corpus. Seven reject disposable copies with a changed decoded result, lost one-key null semantics, changed refusal class, changed refusal reason, changed source bytes, a missing case, or a changed `source.version`. The tests remove their temporary files.

To inspect a candidate fixture without replacing the checked-in corpus, pass its path to `verify.mjs`.

```sh
node fixtures/parity/yaml-flow-properties/verify.mjs /tmp/candidate.json
```

To regenerate the corpus after reviewing an intentional source change, run the generator without `--check`, then rerun the verifier and self-test.

```sh
node fixtures/parity/yaml-flow-properties/generate.mjs
```
