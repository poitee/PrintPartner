# Measure GitHub Actions cache inventory

Run from the repository root with Python 3.10 or newer. Capture requires an authenticated `gh` with read access to Actions caches and support for `api --paginate --slurp`. Summary and compare run offline.

```sh
python3 scripts/cache_census/census.py capture OWNER/REPO --output /tmp/cache-before.json
python3 scripts/cache_census/census.py summary /tmp/cache-before.json
python3 scripts/cache_census/census.py capture OWNER/REPO --output /tmp/cache-after.json
python3 scripts/cache_census/census.py compare /tmp/cache-before.json /tmp/cache-after.json
python3 -m unittest discover -s scripts/cache_census -p 'test_*.py' -v
```

All reports use JSON. Capture writes to stdout unless `--output` is supplied. Use `--output` to publish a complete snapshot atomically. Existing files are never overwritten. `--output` requires a filesystem with hardlink support. On filesystems without hardlinks, omit `--output` and use stdout. Output files use the temporary file's private permissions; publication does not guarantee durability across a system crash. API failures, malformed entries, duplicate IDs, changing counts, and incomplete pagination exit nonzero without a snapshot. Shell redirection can still create an empty file before the command runs.

Capture calls only `gh api --method GET --hostname github.com repos/OWNER/REPO/actions/caches` with `per_page=100`, ascending creation time, `--paginate`, and `--slurp`. It never changes caches, repository settings, workflows, or schedules. See the [cache API reference](https://docs.github.com/en/rest/actions/cache#list-github-actions-caches-for-a-repository) and [gh api reference](https://cli.github.com/manual/gh_api).

## Snapshot and reports

Schema version 1 contains `repository`, `collection_started_at`, `collection_finished_at`, `entries`, and `api`. Collection timestamps use UTC. `entries` maps decimal cache IDs to `id`, `key`, `ref`, `version`, `size_in_bytes`, `created_at`, and `last_accessed_at`. `api` records `per_page` and each page's ordinal, `total_count`, and observed `entries_count`. Loading saved snapshots revalidates these fields and counts. Repository names composed only of dots are rejected.

Timestamp validation accepts fractional seconds of any length on Python 3.10 and newer. Comparisons use microsecond resolution: shorter fractions are padded with zeros, and digits beyond six are truncated. Timestamps that differ only beyond six digits compare as equal, so they cannot establish strictly nonoverlapping collection windows. Snapshots and reports preserve the original timestamp strings.

Summary totals entries and bytes by exact key, ref, key/ref pair, and key family. Family matching uses these prefixes, and unrecognized keys remain in `other`:

- `buildkit-blob-` maps to `buildkit-blob`.
- `sccache-`, `sccache_`, and `sccache/` map to `sccache`.
- `node-cache-` maps to `setup-node`.
- `setup-python-` maps to `setup-python`.
- `v<digits>-rust-` maps to `rust-cache`.
- `tauri-cli-` maps to `tauri-cli`.

Families describe key patterns, not verified producers. Exact keys remain available in every report.

Compare requires the same repository and a later collection that starts strictly after the earlier collection finishes. Repository names are case insensitive. Reports include disappeared and added cache entries, bytes, groups, retained entry count, and net changes. Replacing a cache with the same key and a new ID counts as both a disappearance and an addition. Disappeared bytes use the earlier sample. Added bytes use the later sample.

## Measurement limits

Pagination is not atomic. Capture requires consistent reported counts, expected page lengths, unique IDs, and an observed total equal to the API total. Concurrent additions and removals can offset each other and pass those checks. Ascending creation time reduces movement caused by access updates but cannot freeze the list. Retry captures that fail validation.

Disappearance records an ID missing from the later inventory. It does not prove eviction, eviction cause, or a retention policy. Caches created and removed between captures are invisible. A single sample cannot yield historical eviction frequency. This tool does not estimate an eviction rate.

The optional repository usage endpoint, `actions/cache/usage`, is intentionally not collected. Its data refreshes independently and may lag the cache list. Its totals would not prove list completeness. Collection timestamps bound the requests, not the creation or removal time of any individual cache.

See the [2026-10-18 observations](evidence/2026-10-18/README.md) for real snapshots, reproduction commands, and the proposed next policy slice.
