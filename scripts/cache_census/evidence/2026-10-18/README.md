# GRE-662 cache observations

These are read-only observations of `poitee/PrintPartner` on 2026-10-18 UTC.
They establish a baseline and observed disappearance, not eviction causes or historical eviction frequency.

The first two samples were collected with this official GitHub CLI GET command:

```sh
gh api --method GET --paginate --slurp 'repos/poitee/PrintPartner/actions/caches?per_page=100&sort=created_at&direction=asc'
```

The JSON pages were wrapped with collection start/end timestamps and converted to
the tool's version 1 schema. The conversion retained every cache entry field and
validated page counts with `load_snapshot`. The original pages and conversion
script were not retained, so their collection provenance cannot be independently
reconstructed. `direct.json` was collected through
the finished command:

```sh
python3 -B scripts/cache_census/census.py capture poitee/PrintPartner --output /tmp/cache-direct.json
```

Each committed snapshot uses compact JSON to keep the evidence small. Recompute
the observations from the repository root:

```sh
python3 -B scripts/cache_census/census.py summary scripts/cache_census/evidence/2026-10-18/083722.json
python3 -B scripts/cache_census/census.py summary scripts/cache_census/evidence/2026-10-18/083800.json
python3 -B scripts/cache_census/census.py summary scripts/cache_census/evidence/2026-10-18/direct.json
python3 -B scripts/cache_census/census.py compare scripts/cache_census/evidence/2026-10-18/083722.json scripts/cache_census/evidence/2026-10-18/083800.json
```

The 08:37:22 sample lists 37 entries and 11,042,679,395 bytes. Rust keys account
for 12 entries and 8,824,398,370 bytes. BuildKit blobs account for 19 entries and
1,753,722,948 bytes. Main holds 27 entries and 4,360,102,148 bytes.

The 08:38:00 sample lists 36 entries and 10,128,032,035 bytes. Between these
observations, two Rust IDs disappear, totaling 1,657,064,306 bytes:

* `9113466456`, `refs/pull/653/merge`, 990,824,472 bytes.
* `9113481031`, `refs/pull/662/merge`, 666,239,834 bytes.

A new main-branch macOS Rust entry, `9114199179`, adds 742,416,946 bytes.
The 19 BuildKit blob IDs remain present in both samples. At the subsequent PR
state check, PR #653 was open and PR #662 had merged at 08:32:38 UTC.
Neither PR state proves why its cache disappeared.

The direct CLI sample lists 37 entries and 10,869,502,466 bytes. It is another
observation of a changing inventory, not a historical trend.

## Limits and next policy slice

These short, non-atomic collection windows cannot establish an eviction rate.
Entries created and removed between samples are invisible. The
[list API](https://docs.github.com/en/rest/actions/cache#list-github-actions-caches-for-a-repository)
does not provide a removal reason. Do not label disappearance as proven eviction.
No BuildKit disappearance or reduction in registry requests was observed here.

The smallest candidate policy is `save-if: ${{ github.ref == 'refs/heads/main' }}`
on the remaining Rust cache writers, leaving PRs to restore. This is a
[standard rust-cache input](https://github.com/Swatinem/rust-cache#example-usage).
The current main tree already restricts the macOS bundle cache, but other Rust
cache steps still save by default. This proposal follows the large measured
Rust footprint. Its benefit has not been demonstrated by this slice.

Before that change, collect snapshots around representative PR and main runs,
record their cache restore/save results, and correlate disappearing IDs with
any available deletion activity or service evidence. Afterward, repeat those
observations to check whether PR saves stop, main restores remain useful, and
BuildKit entries persist. Registry request counts need separate job evidence.
PRs #601 and #474 owned workflow edits when these samples were collected; both
have since merged. Recheck open PR file ownership before a later policy slice.
No cache policy, workflow, repository limit, registry mirror, or persistent
schedule changed here.
