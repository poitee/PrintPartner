# Source scan failure metadata

Behind the default-off `desktop_rebuild` feature, `mark_local_failure` parses stored Source metadata the way Node's `updateSource` does before setting `sync_error` and `sync_required`.

SQL NULL and an empty string start an empty metadata object. A JSON object retains its existing keys. Malformed text, arrays, JSON strings, numbers, booleans, and JSON null retain their exact stored text in a `raw` field. The failure replaces `sync_error` with the error detail and sets `sync_required` to `true`.

Rust writes the same text as Node's `JSON.stringify(JSON.parse(...))`, byte for byte. Object numbers use JavaScript precision, and nonfinite values become JSON null, including inside nested objects and arrays. Strings and keys keep lone UTF-16 surrogates, which are written back as `\uXXXX` escapes. Keys follow JavaScript property order: array-index keys in ascending order, then other keys in first-seen order. A repeated key keeps its first position and its last value. String categories use the same path normalization as catalog updates, and trimming stops at a lone surrogate. Non-string categories retain their value. Objects nested deeper than 128 levels keep their exact stored text in `raw`, where Node would keep the object.

The update requires the Source ID and tenant to match. It runs in the caller's transaction, so rolling back restores the exact original metadata, including SQL NULL.

`fixtures/parity/source-scan/generate.mjs` executes the Node scan failure handler with a real SQLite-backed `AppRepository`. Only `markSourceSynced` is replaced to inject a failure. The handler calls the real `updateSource`; the generator records the stored `metadata_json` text as the expected result. The Rust parity test seeds the same raw values, checks rollback and tenant rejection, and requires the committed text to equal Node's.

Regenerate the fixtures from the repository root with `node fixtures/parity/source-scan/generate.mjs`. Check them with `node fixtures/parity/source-scan/generate.mjs --check`.

This slice changes failure metadata parsing. Successful scan metadata handling and the other GRE-707 findings remain separate work.
