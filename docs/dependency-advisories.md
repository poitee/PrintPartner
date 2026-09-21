# Dependency advisory triage

Tracking: [issue 67](https://github.com/poitee/PrintPartner/issues/67).

The September 21, 2026 lockfile updates `adm-zip` from 0.6.0 to 0.6.1
and the Hono override from 4.13.1 to 4.13.8. `npm audit` reports zero
vulnerabilities with these versions. No audit thresholds or CI checks changed.

## Archive paths

Production code uses `adm-zip` in `services/export-kit.ts` to read `kit.json`
from uploaded Kit ZIPs. It rejects an oversized declared JSON entry before
calling `getData()` and checks decoded length afterward. This still reaches
archive parsing and decompression, so upgrading addresses the new declared-size
allocation advisory as well as the earlier extraction advisory.

Source ZIP extraction uses the streaming `fflate` importer in
`services/archive-import.ts`. It checks entry paths, entry count, declared
size, and actual expanded bytes. PrintPartner does not call the vulnerable
`adm-zip` destination extraction helpers. Existing tests cover traversal,
expansion limits, forged Kit entry sizes, and hostile upload routes.

## MCP paths

The MCP SDK's Node Streamable HTTP transport imports `getRequestListener`
from `@hono/node-server`. PrintPartner's routes use Fastify; application code
does not call Hono's `toSSG()` or `parseBody()`. Hono remains a transitive
runtime dependency, so the patched override removes the vulnerable versions
without relying on those paths staying unused.

Validation covers archive imports, Kit parsing, upload route hardening, MCP
HTTP/session isolation and capacity, dependency audit, and release checks.
