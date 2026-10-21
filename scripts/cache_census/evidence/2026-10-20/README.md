# GRE-662 main-only Rust cache saves: before sample

These are read-only observations of `poitee/PrintPartner` on 2026-10-20 UTC,
taken before Rust cache saves were limited to `refs/heads/main`.

`before.json` was collected with the following command and then rewritten as compact JSON:

```sh
python3 -B scripts/cache_census/census.py capture poitee/PrintPartner --output /tmp/before.json
python3 -B scripts/cache_census/census.py summary scripts/cache_census/evidence/2026-10-20/before.json
```

The sample lists 85 entries and 10,694,709,739 bytes. Rust keys account for
12 entries and 7,032,609,980 bytes. Of these, 8 entries and 5,365,605,790 bytes
are on `refs/heads/main`. The other 4 entries and 1,667,004,190 bytes are
`rust (windows)` entries on `refs/pull/873/merge`, `892`, `893` and `895`.
No other Rust entries are on a PR ref. BuildKit blobs account for 54 entries and
3,069,118,184 bytes.

## Run logs

Main push run `39434456824` restored a full-match key in all three Rust jobs and
reported `Cache up-to-date`, so it did not upload:

* `v0-rust-rust-linux-Linux-x64-2f57fd20-022889a9`
* `v0-rust-rust-windows-Windows_NT-x64-16a87b50-6de7e9f0`
* `v0-rust-rust-macos-Darwin-arm64-1c895678-022889a9`

Four PR `rust (windows)` jobs ran on self-hosted `pp-win-*` runners:
`118600154820`, `118541276014`, `118500287471` and `118654101902`.
Each job computed the restore key `v0-rust-rust-windows-Windows_NT-x64-42eff93b`,
reported `No cache found` and then saved about 417 MB.
Job `118600154820` took 2 minutes 8 seconds to upload, at 4.2 MB/s.
The `42eff93b` environment hash differs from main's `16a87b50`.
PR Windows jobs therefore do not restore main's entry, with or without this change.

PR `rust (linux)`, `linux-smoke` and `webkit-stl` jobs run on self-hosted `pp-local`.
Those jobs skip rust-cache, so they neither restore nor save it.

## Expected after sample

After the change, PR, merge-queue and other-branch runs must not create new
`v0-rust-` entries. Main and scheduled runs must still restore a full match.
BuildKit entries are unaffected by this change. Compare a later capture with:

```sh
python3 -B scripts/cache_census/census.py compare scripts/cache_census/evidence/2026-10-20/before.json /tmp/after.json
```

Collect the after sample once the current PR Windows entries age out.
