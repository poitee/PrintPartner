# Upload admission parity

`uploads.json` records 25 cases from the Node `writeUploadedFiles` implementation.
The generator creates sparse input files in temporary directories, calls the actual
writer, and removes each directory after the call. Oversized exact, case-only,
and normalized alias duplicates all return the 256 MiB upload limit error before
path validation. Under the limit, duplicate errors retain the second original
path spelling.

To regenerate from the repository root with Node 22 and the web dependencies installed:

```sh
node fixtures/parity/uploads/generate.mjs
node fixtures/parity/uploads/generate.mjs --check
```

The Rust `upload_journal` integration test compares these results with journal
admission and checks that refusals leave table counts unchanged. Its separate
size-overflow test uses `u64::MAX` metadata to check `Input size overflow`, including
when duplicate paths appear before the size that overflows. That case cannot use
real Node input files.
