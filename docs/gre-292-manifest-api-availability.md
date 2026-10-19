# GRE-292 manifest API availability

## Source and version

This document describes the six Source, Plan, and submission handlers named by GRE-292.

Baseline main is `f00471f13d2f0e69631d3130e594b9244f93e01d`, with web package version `3.3.0`.
That snapshot returns false Source presence, empty maintenance and warning collections, zero summary counts, and fabricated submission YAML.
Those success responses do not establish real state or a usable community submission bundle.

PR268 commit `7916c7bfc05f8fe8815a8e759764a2201ef4014b` independently corrects submission export.
The remaining corrections are on `program/gre292-c233-r2`.
The API implementation and reviewed Rust import were built and exercised through real Node22 HTTP at `9f0f83620df0cb966390714aa10716d7c809c587`.
The final documentation commit is also built and exercised. Its exact tested SHA and full transcripts are recorded in the follow-up PR's Evidence section.

These corrections are unreleased. No released version or deployed instance is claimed to contain them.
The web package version remains `3.3.0`. Package identity alone does not distinguish the baseline from either correction.

## Source manifest presence

`GET /sources/:id/has-manifest` and `GET /api/v1/sources/:id/has-manifest` inspect the tenant-owned Source's current resolved content root.
A safe regular `print-partner.manifest.yaml` file found by the existing Source manifest locator returns:

```json
{"has_manifest":true,"manifest_kind":"repo"}
```

No resolved local content or no safe regular canonical file returns:

```json
{"has_manifest":false,"manifest_kind":null}
```

This is canonical file availability, not YAML validation or submission support.
A directory or a symlink escaping the content root is not an available canonical manifest.
The handler uses the same file locator as the existing repository manifest reader.
It observes file additions and removals on subsequent requests.

Foreign, missing, and invalid Source IDs return HTTP `404` with `{"detail":"Source not found"}`.
The owned repository lookup runs before the file locator. No filesystem path or foreign manifest state is returned.

## Unsupported reports

These GET routes return HTTP `501` after the configured authentication checks.
Each body contains the listed `code` and `detail`, with no success-shaped collections or counts.

- `/sources/maintenance` and `/api/v1/sources/maintenance` return `source_maintenance_unsupported` and "Source maintenance reporting is not supported by this web API."
- `/plans/maintenance`, `/api/v1/plans/maintenance`, and `/api/v2/plans/maintenance` return `plan_maintenance_unsupported` and "Plan maintenance reporting is not supported by this web API."
- `/plans/:id/manifest-summary`, `/api/v1/plans/:id/manifest-summary`, and `/api/v2/plans/:id/manifest-summary` return `plan_manifest_summary_unsupported` and "Plan manifest summary is not supported by this web API."
- `/plans/:id/manifest-warnings`, `/api/v1/plans/:id/manifest-warnings`, and `/api/v2/plans/:id/manifest-warnings` return `plan_manifest_warnings_unsupported` and "Plan manifest warning reporting is not supported by this web API."

For example:

```json
{"code":"plan_manifest_warnings_unsupported","detail":"Plan manifest warning reporting is not supported by this web API."}
```

These operations read no Source, Plan, manifest, or warning state and mutate no data.
Authenticated owner, foreign, missing, and malformed ID requests receive the same operation-specific refusal.
The existing app authentication hooks still run. The unsupported handlers do not promise resource existence checks.

Source maintenance has no complete catalog-orphan, category, or drift computation.
The existing manifest builder and accepted Plan review do not implement the old summary count contract.
Kit-import warnings exist at import time, but do not implement a persisted Plan warning or maintenance report.

## Submission draft export

Both `POST /manifest-registry/export-draft` and `POST /api/v1/manifest-registry/export-draft` retain PR268's HTTP `501` response:

```json
{
  "code": "manifest_export_draft_unsupported",
  "detail": "Community manifest submission draft export is not supported by this web API."
}
```

The response contains no submission YAML, metadata YAML, slug, or issue body.
The operation reads no Source, Plan, manifest, or warning state.
Authenticated requests receive the same response with owned IDs, foreign IDs, missing IDs, an empty object, or no body.
Fastify's normal request parsing and size limits still apply.

## Authentication and aliases

When authentication is required, requests without credentials return HTTP `401` with `{"detail":"Authentication required"}`.
Fastify's HEAD aliases for registered GET routes use the same status with an empty body.
Source presence, Source maintenance, and submission export are not registered under `/api/v2`. Authenticated requests to those v2 paths return HTTP `404`.

The route census found no exact typed caller or success response declaration for the five Source and Plan handlers or the export POST.
Existing route inventories, body-limit fixtures, and Rust gateway operation metadata describe paths and methods rather than successful report data.
The paths and methods remain registered, so that metadata remains applicable.

## Available manifest reads and evidence

The embedded registry reads remain available at `GET /manifest-registry` and `GET /manifest-registry/:slug`.
Community manifest slugs reserve `kit-catalog` and `registry-index`. Requests for either reserved slug return HTTP `404`.
The registry index remains available through `GET /manifest-registry`.
Writes reject reserved slugs. Legacy stored reserved slugs produce a warning and skip community manifest reads.
`fetchManifestRegistry` consumes that GET and remains available.
`GET /sources/:id/repo-manifest` reads stored repository YAML when present.
The owned `GET /plans/:id/kit-manifest` reads the stored kit manifest.
Existing manifest builder, kit editing, and accepted Plan review APIs retain their own contracts.
These reads do not produce community submission bundles.

The behavior tests and actual HTTP run use a real canonical Source manifest with an option group, a stored kit manifest, and the missing-source warning generated by the real kit importer.
The warning proves that an empty success cannot be inferred from the reporting handlers. It is not evidence that those handlers calculate warnings.
Repeated owner, foreign, missing, unauthenticated, alias, and file-change requests verify the computed presence or explicit refusal.
Product database snapshots and Source manifest hashes remain unchanged across the read and refusal requests.

Independent review, current CI, promotion, release availability, and full ticket acceptance remain separate gates.
