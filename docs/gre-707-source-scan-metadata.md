# Source scan failure metadata

Behind the default-off `desktop_rebuild` feature, `mark_local_failure` parses stored Source metadata with `catalog::metadata` before setting `sync_error` and `sync_required`.

SQL NULL and an empty string start an empty metadata object. A JSON object retains its existing keys. Malformed text, arrays, JSON strings, numbers, booleans, and JSON null retain their exact stored text in a `raw` field. The failure replaces `sync_error` with the error detail and sets `sync_required` to `true`.

Object numbers use JavaScript precision, and nonfinite values become JSON null, including inside nested objects and arrays. String categories use the same path normalization as catalog updates. Non-string categories retain their value.

The update requires the Source ID and tenant to match. It runs in the caller's transaction, so rolling back restores the exact original metadata, including SQL NULL.

`fixtures/parity/source-scan/generate.mjs` executes the Node scan failure handler with a real SQLite-backed `AppRepository`. Only `markSourceSynced` is replaced to inject a failure. The handler calls the real `updateSource`; the generator reads and parses the stored `metadata_json` as the expected result. The Rust parity test seeds the same raw values, checks rollback and tenant rejection, and compares committed metadata with those Node results.

Regenerate the fixtures from the repository root with `node fixtures/parity/source-scan/generate.mjs`. Check them with `node fixtures/parity/source-scan/generate.mjs --check`.

This slice changes failure metadata parsing. Successful scan metadata handling and the other GRE-707 findings remain separate work.
