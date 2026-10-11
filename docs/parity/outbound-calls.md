# TypeScript outbound calls and offline behavior

Static inventory for GRE-563, inspected at `af7c984` (the source revision in this worktree). Paths and line numbers below refer to that revision; this document adds no runtime changes or live offline-test results.

Scope: application TypeScript HTTP/MQTT call sites, including SDK calls and shared wrappers, for GitHub sync, update checks, search, guide fetch, slicers, and printers. Other outbound features found by the same search are included separately. Tests, build scripts, Rust/Python implementations, ordinary external navigation links, and database connections are excluded. Browser-to-engine transports are grouped separately rather than listing every API endpoint that delegates to them.

Classification describes the effect on the requested operation, not the entire app:

- **fail-soft**: catches a failure and returns a fallback, empty data, offline status, or diagnostic result so unrelated local work can continue.
- **hard-fail**: rejects/throws, or reports failure of an explicit sync, transfer, login, or container action without completing it. A caught `{ ok: false }` transfer still counts as hard-fail.
- **unknown**: a shared transport delegates failure handling to its caller; no single feature-level outcome is established here.

“No internet” means WAN unavailable with localhost/LAN still reachable. Configurable remote hosts can require WAN; for LAN targets the failure behavior shown applies when that target is also unreachable. Timeouts are explicit application settings, not assumed browser/library defaults. Cancellation signals and byte limits are not time deadlines. DNS validation happens before the fetch wrappers dispatch; an AbortSignal on fetch is not proof of an end-to-end DNS deadline. Per-request deadlines do not bound an entire multi-request workflow.

## GitHub, update checks, search, and guide fetch

All paths in this table are relative to `web/apps/server/src/`.

| File:line | Target | Trigger | Behavior with no internet / unreachable target | Timeout | Classification |
| --- | --- | --- | --- | --- | --- |
| `services/github-client.ts:16` | GitHub API, shared Octokit transport | Any `createGithubClient` consumer below | Fetch rejects; consumer decides fallback or failure. Bounds response size, not availability. | 120 s per request by default, caller-overridable; signal covers body read | unknown |
| `services/github-sync.ts:140` | GitHub sync: branch enumeration | Resolve an ambiguous deep GitHub URL ref during inspection/sync | Catches branch-list failure and uses the parsed ref; subsequent required calls may still fail. | 120 s per API request via GitHub client | fail-soft |
| `services/github-sync.ts:176`, `services/github-sync.ts:177` | GitHub sync: repository metadata and branches | User requests GitHub branch choices | Rejects branch-list operation; no offline branch list. | 120 s per API request | hard-fail |
| `services/github-sync.ts:201` | GitHub sync: tags | User requests GitHub tag choices | Rejects tag-list operation. | 120 s per API request | hard-fail |
| `services/github-sync.ts:336`, `services/github-sync.ts:338`, `services/github-sync.ts:388` | GitHub sync: commit, recursive tree, default branch fallback | Pre-sync tree summary or Source sync job | Required API calls reject; retrying the default branch cannot restore an unavailable API. Sync does not publish a new snapshot on failure. | 120 s per API request | hard-fail |
| `services/github-sync.ts:261` | GitHub sync: `raw.githubusercontent.com` files | Materialize selected STL, metadata, and documentation files in a Source snapshot | Rejects the file download and snapshot operation; existing published snapshots remain usable. | 120 s default per file, configurable `fileTimeoutMs`; includes response body | hard-fail |
| `services/github-readme.ts:66` | GitHub README | Request live Source README after cache miss | Uses a fresh five-minute memory cache without fetching; on fetch failure falls back to synced disk README or empty markdown. | 120 s per API request | fail-soft |
| `services/source-update-check.ts:22` | Source update check: GitHub commit | Check-source-updates job or Source watcher | Catches failure, stores `remote_update_status: unknown` and checked timestamp; does not sync. | 120 s per Source API request | fail-soft |
| `services/app-update-check.ts:82` | App update check: GitHub latest release | `/settings/update-check` request with enabled checks, no cache hit/override | Catches failure; `latest_version: null`, `update_available: false` (no banner), caches result. Disabled/override paths avoid fetching. A stalled request can delay this result. | None explicitly set | fail-soft |
| `services/search/brave.ts:27` | Search provider: Brave Search API | `web_search` resolved to Brave with API key | Catches failure; empty hits and error/setup hint. | 30 s default via `search/index.ts:254`, caller-overridable; caller cancellation combined | fail-soft |
| `services/search/exa.ts:26` | Search provider: Exa API | `web_search` resolved to Exa with API key | Catches failure; empty hits and error/setup hint. | Same 30 s search deadline | fail-soft |
| `services/search/duckduckgo.ts:90` | Search provider: DuckDuckGo HTML | DuckDuckGo search; also HTTP backend for `anthropic-native` / `openai-native` selections | Catches failure; empty hits and diagnostic. `SEARCH_PROVIDER=none` sends no request. | Same 30 s search deadline | fail-soft |
| `services/guide-ingest.ts:141` | Guide fetch: arbitrary public web page | Assistant `fetch_web_page` tool when URL ingest enabled | Catches failure; `ok: false`, empty text and error, retaining untrusted-content banner. | No own deadline; optional caller signal (`assistant/tools.ts:2424`) | fail-soft |
| `services/guide-ingest.ts:871` | Guide fetch: arbitrary public guide URL | Assistant `ingest_guide_url` tool when URL ingest enabled | Catches failure; `ok: false`, empty extract/text and error. Text ingest can work without this fetch. | No own deadline; optional caller signal (`assistant/tools.ts:2388`) | fail-soft |
| `lib/outbound-url.ts:258`, `lib/outbound-url.ts:298` | Shared public fetch / configurable connector fetch | Guide/search/cover/webhook or integration/provider callers | DNS/transport errors propagate; these wrappers do not supply an offline fallback. | No own deadline; forwards caller signal | unknown |

## Slicers and printers

All paths in this table are relative to `web/apps/server/src/`. Local slicers and printers do not inherently require internet. PrusaLink Digest probe and retry calls (`integrations/adapters/prusalink.ts:66`, `:87`, `:105`, `:122`) use the operation's signal; its default is 30 s when none is supplied. Moonraker and Home Assistant wrappers (`integrations/adapters/moonraker.ts:80`, `integrations/adapters/home-assistant.ts:85`) likewise default to 30 s and reuse the signal across redirect hops. The rows below identify their operation-specific callers.

| File:line | Target | Trigger | Behavior with no internet / unreachable target | Timeout | Classification |
| --- | --- | --- | --- | --- | --- |
| `integrations/adapters/slicer-sidecar.ts:55`, `integrations/adapters/slicer-sidecar.ts:63`, `integrations/adapters/slicer-sidecar.ts:141` | Slicer sidecar `/healthz`, legacy `/health` | Test slicer integration connection | LAN/localhost can work offline. Unreachable sidecar returns `ok: false` diagnostic after trying both health paths; one transient GET retry uses the same signal. | 10 s per health path, including retry/body | fail-soft |
| `services/slicer-docker.ts:424`, `services/slicer-docker.ts:427` | Slicer Docker engine (socket or configured network host) | Refresh status; find container before an action | Local engine works offline; status refresh catches engine failure as `state: error`; action callers handle failure separately. | None explicitly set | fail-soft |
| `services/slicer-docker.ts:475` | Slicer image pull via Docker engine to registry | User selects Docker pull | Registry access generally needs internet; pull reports `state: error` on failure. | None explicitly set, including progress stream | hard-fail |
| `services/slicer-docker.ts:616`, `services/slicer-docker.ts:633`, `services/slicer-docker.ts:644` (CLI execution `services/slicer-docker.ts:410`) | Slicer Compose service pull/up/stop via Docker CLI | User pulls/starts/stops a `pp_compose` slicer with configured service | Pull needs registry access; local up/stop with installed image can work offline. CLI failure returns `state: error`; missing images may prevent startup offline. | No explicit child-process or network deadline | hard-fail |
| `services/slicer-docker.ts:507`, `services/slicer-docker.ts:511`, `services/slicer-docker.ts:523`, `services/slicer-docker.ts:547` | Slicer Docker engine start/create/stop | User starts/stops slicer container | Local engine with installed image can work offline. Engine/action errors return `state: error`. | No request deadline; stop's `t: 10` is a container grace period, not a network deadline | hard-fail |
| `services/slicer-docker.ts:562` | Slicer Docker engine logs | User requests slicer logs | Local engine can work offline; unavailable engine rejects log retrieval. | None explicitly set | hard-fail |
| `integrations/adapters/moonraker.ts:503` | Printers: Moonraker `/server/info` | Test connection | LAN works offline; unavailable host returns `ok: false` diagnostic. | 8 s | fail-soft |
| `integrations/adapters/moonraker.ts:373` | Printers: Moonraker object status | Status polling / device discovery | LAN works offline; `getStatus` catches as `state: offline`, `listDevices` catches as empty list. | Wrapper default 30 s | fail-soft |
| `integrations/adapters/moonraker.ts:352` | Printers: Moonraker system uptime | Supplement printer status with system uptime | Catches failure as undefined uptime, preserving printer status. | Wrapper default 30 s | fail-soft |
| `integrations/adapters/moonraker.ts:428`, `integrations/adapters/moonraker.ts:559` | Printers: Moonraker exclude objects / filament usage | Object list / filament usage query | Catches failure as empty object list / null usage. | 8 s each | fail-soft |
| `integrations/adapters/moonraker.ts:166`, `integrations/adapters/moonraker.ts:460` | Printers: Moonraker directory / stored file | Browse printer storage / open print file | LAN works offline; unavailable host rejects browsing/download. | Listing 15 s; file 120 s | hard-fail |
| `integrations/adapters/moonraker.ts:227`, `integrations/adapters/moonraker.ts:479` | Printers: Moonraker webcam list / camera view | List cameras / proxy camera stream | LAN works offline; unavailable host rejects listing/view. | List 10 s; view 60 s | hard-fail |
| `integrations/adapters/moonraker.ts:605`, `integrations/adapters/moonraker.ts:624` | Printers: Moonraker upload / optional print start | Send G-code to printer, optionally start | Unavailable host returns `ok: false`. HTTP start failure after upload reports uploaded but `started: false`; transport failure reaches outer failure catch. | Upload 120 s; start 15 s | hard-fail |
| `integrations/adapters/prusalink.ts:681` | Printers: PrusaLink info, fallback status | Test connection | LAN works offline; catches failure as `ok: false`; optional status failure after valid info can still report connected. | Info 8 s; status 8 s, optional job metadata 8 s | fail-soft |
| `integrations/adapters/prusalink.ts:371`, `integrations/adapters/prusalink.ts:333` | Printers: PrusaLink status / job metadata | Status polling / device discovery | Unavailable host becomes offline status or empty device list; optional job metadata failure yields empty metadata. | 8 s per status/job request | fail-soft |
| `integrations/adapters/prusalink.ts:745`, `integrations/adapters/prusalink.ts:771`, `integrations/adapters/prusalink.ts:821` | Printers: PrusaLink job, G-code prefix, usage | Object list / filament usage | Failure yields empty object list / null usage. | Job 8 s; G-code prefix 15 s | fail-soft |
| `integrations/adapters/prusalink.ts:476`, `integrations/adapters/prusalink.ts:520`, `integrations/adapters/prusalink.ts:632`, `integrations/adapters/prusalink.ts:213` | Printers: PrusaLink storage discovery, listing, file metadata/download | Browse storage / open advertised download URL | LAN works offline; unavailable host rejects operation (or returns unsuccessful metadata response). | Storage 10 s; listing 15 s idle; metadata 15 s; download 120 s idle, reset by nonempty chunks (no total download deadline) | hard-fail |
| `integrations/adapters/prusalink.ts:593`, `integrations/adapters/prusalink.ts:664` | Printers: PrusaLink cameras / snapshot | List cameras / view snapshot | LAN works offline; unavailable host rejects operation. | List 10 s; snapshot 30 s | hard-fail |
| `integrations/adapters/prusalink.ts:877` | Printers: PrusaLink PUT file, optional print-after-upload header | Send G-code to printer | Unavailable host returns `ok: false`; transfer cannot complete. | 120 s including Digest probe/retry | hard-fail |
| `integrations/adapters/bambu.ts:236`, `integrations/adapters/bambu.ts:304` (default MQTT factory `:28`) | Printers: Bambu LAN MQTT TLS | Test connection / status polling | LAN mode works without WAN. After DNS validation completes, errors/closure/MQTT deadline resolve offline status; test returns failure diagnostic. Stalled hostname validation can delay either operation indefinitely. No auto-reconnect. | Hostname validation/DNS preflight has no explicit deadline and precedes MQTT timers; then connect 8 s, status wait 10 s | fail-soft |
| `integrations/adapters/home-assistant.ts:206`, `integrations/adapters/home-assistant.ts:226` | Printers: HA API / optional entity probe | Test connection | LAN works offline; unavailable API gives `ok: false`; optional unreachable entity can retain successful connection diagnostic. | 8 s per probe | fail-soft |
| `integrations/adapters/home-assistant.ts:134` | Printers: HA entity status | Status polling / device discovery | LAN works offline; unavailable host becomes offline status or empty device list. | 10 s | fail-soft |
| `integrations/adapters/home-assistant.ts:343` | Printers: HA upload webhook | Send print file via HA automation | LAN works offline; unavailable host gives `ok: false`. Successful webhook does not prove a print started. | 60 s | hard-fail |

The TS sidecar adapter only probes health in this revision: its header describes slice protocols, but no TS POST `/slice` or `/v1/slice` call was found. Slicer GUI links launch external navigation, and local profile/file operations are not outbound HTTP calls. Bambu's TS adapter provides status rather than file upload.

## Other outbound features found

Paths are relative to `web/`.

| File:line | Target | Trigger | Behavior with no internet / unreachable target | Timeout | Classification |
| --- | --- | --- | --- | --- | --- |
| `apps/server/src/lib/source-cover.ts:205`, `apps/server/src/lib/source-cover.ts:275` | Source cover image / source page (including GitHub OpenGraph) | Resolve uncached/forced Source cover | Catches failure, tries other candidates including local files; returns null if none; fresh cached cover avoids fetch. | Image 20 s; page 15 s | fail-soft |
| `apps/server/src/assistant/openai-adapter.ts:197`, `:209`, `:251`, `:304`; `apps/server/src/assistant/anthropic-adapter.ts:129`, `:169` | OpenAI-compatible endpoint / Ollama / Anthropic | Assistant completion, tool completion, or streaming | Public providers require WAN; local Ollama may work offline. Completion rejects; stream reports `onError`. Optional guide LLM refinement catches failure and retains heuristic extract (`guide-ingest.ts:764`). | 5 min via `assistant/provider-fetch.ts:9`, combined with caller cancellation | hard-fail |
| `apps/server/src/integrations/adapters/ai-assistant.ts:90` | Provider model listing / probe | Test AI integration connection | Local endpoint may work offline; catches failure as `ok: false` diagnostic. | 8 s | fail-soft |
| `apps/server/src/services/discord-notify.ts:190` | Discord webhook | Notification event / test delivery | Retries, logs and returns failed delivery; never throws, original local work can continue. | 10 s per attempt, up to three attempts plus backoff | fail-soft |
| `apps/server/src/services/webhook-store.ts:114` | Configured event webhooks (LAN allowed) | Matching application event | LAN targets may work offline; catches/logs each delivery failure. | 10 s per webhook | fail-soft |
| `apps/server/src/integrations/spoolman-client.ts:204` | Spoolman info/health and spool inventory | Test connection / list spools | LAN works offline; connection test catches failure diagnostic, inventory retrieval rejects. | 8 s per probe/list, shared across redirects | unknown |
| `apps/server/src/integrations/spoolman-client.ts:348` | Spoolman spool consumption | Record consumed filament | LAN works offline; unavailable target rejects consumption write. | 8 s | hard-fail |
| `apps/server/src/routes/auth.ts:56` (callers `:361`, `:376`, `:388`, `:458`, `:468`) | GitHub / Discord OAuth token and user APIs | OAuth login callback | Pre-header fetch rejection maps to 502 network / 504 timeout. Body read/timeout errors become null in `auth.ts:131`: token exchange returns 401, profile returns 502, optional GitHub email can continue without email. | 15 s per provider request | hard-fail |
| `apps/web/src/instrument.ts:22` | Configured Sentry DSN via browser SDK | SDK initialization when `VITE_SENTRY_DSN` is set; captured React errors (`apps/web/src/main.tsx:18`) and sampled traces | DSN may require WAN; no app-defined transport fallback or offline handling is established here. SDK owns delivery/queue/drop behavior; no traffic configured without DSN. | None explicitly configured in application; SDK defaults not verified | unknown |
| `apps/server/src/services/password-reset-mail.ts:54` | Configured SMTP server | Password reset email delivery | LAN SMTP may work offline; configured transport failure rejects delivery. No SMTP configured returns unsent/dev result without a network call. | No explicit transport deadline configured | hard-fail |
| `apps/web/src/lib/googleDrive.ts:144`, `:151` | Google Identity Services script | Start Google Drive authorization | Script error/deadline rejects loading; loader resets for retry. | 15 s script-load deadline; no token-popup deadline established here | hard-fail |
| `apps/web/src/lib/googleDrive.ts:229`, `:250`, `:269` | Google Drive upload, file list, download/export | User exports/imports a manifest via Drive | Network rejection fails requested Drive operation. | None explicitly set | hard-fail |

## Browser-to-engine calls

These reach the configured Print Partner engine (usually localhost or the same LAN), rather than directly calling the public providers above. Paths are relative to `web/apps/web/src/`.

| File:line | Target | Trigger | Behavior with no internet / unreachable target | Timeout | Classification |
| --- | --- | --- | --- | --- | --- |
| `api/contractRequest.ts:191`, `api/engineTransport.ts:49` | Engine API | Contract requests / legacy API requests across UI features | Local engine can work offline; unreachable engine throws transport error/rejects. Feature-specific callers decide UI recovery. | No default deadline; `engineTransport` forwards optional caller signal | unknown |
| `api/jobWebSocket.ts:59` | Engine job WebSocket | Observe running job | Local engine can work offline; reports errors and reconnects after close, starting at 500 ms backoff, capped at 10 s. | No explicit connection deadline | fail-soft |
| `lib/fetchWithRetry.ts:33` | Engine mesh/thumbnail media | Thumbnail/mesh load through shared retry helper | Local engine can work offline; retries then returns last HTTP response or throws network error. Callers decide fallback. | No default deadline; optional init signal; two retries by default | unknown |
| `components/SourceCardCover.tsx:97` | Engine Source cover media | Render Source card | Local engine can work offline; catches failure to display cover fallback. | None explicitly set | fail-soft |
| `components/export/accepted-plates/AcceptedPlate3DPreview.tsx:131` | Engine part mesh | Render accepted Plate 3D preview | Local engine can work offline; catches load failure/skips affected mesh. | None explicitly set | fail-soft |

## Reproduce the inventory search

Run from the repository root, then inspect matches and their callers/catches (the search also finds comments and declarations that are not call sites):

```sh
rg -n --glob '*.{ts,tsx,mts}' --glob '!*.test.*' '\b(fetch|safeOutboundFetch|safeConnectorFetch|fetchFn|fetchImpl|fetchAssistantProvider|undiciFetch|mqttConnect)\s*\(|octokit\.|new WebSocket|\.pull\(|\.listContainers\(|\.createContainer\(|\.sendMail\(|GIS_SRC|Sentry\.|composeOrError\(|execFileAsync\(' web/apps/server/src web/apps/web/src web/packages
```

Follow-up searches for operation-specific wrappers and deadlines:

```sh
rg -n --glob '*.{ts,tsx,mts}' --glob '!*.test.*' 'moonrakerFetch\(|prusalinkFetch\(|haFetch\(|fetchSidecar\(|AbortSignal\.timeout|TIMEOUT_MS|idleMs|timeout:|/v1/slice|timeout_s' web/apps/server/src web/apps/web/src web/packages
```
