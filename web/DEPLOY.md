# Deploying Print Partner Web

**First time with Docker?** See the beginner install guide: [docs/INSTALL.md](../docs/INSTALL.md).

## Self-host (default)

### Docker Compose

From the repository root:

```bash
docker compose pull && docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080). Data persists in the `print-partner-data` volume (`/data` in the container). To build from source instead of pulling, use `docker compose up --build`.

### Published images

<!-- release-version:start -->
Release images are published to GitHub Container Registry:

| Image | Tags | Platforms |
|-------|------|-----------|
| `ghcr.io/poitee/print-partner` | `latest`, `X.Y.Z` (one per release, e.g. `3.2.0`) | `linux/amd64`, `linux/arm64` |

Each image bakes the release version, peeled Git commit, tag, and build date into
its runtime identity. `GET /health` reports those values, and the in-app update
checker compares the runtime version with GitHub Releases. Compose defaults to
the prepared `3.2.0` image tag; set `PRINT_PARTNER_VERSION` to another release
explicitly. The compose files keep a `build:` section as a fallback, so
`docker compose up --build` always works without the registry.

**Pull failures:** Package visibility is managed once in GitHub Packages, not
during a release. If `docker compose pull` returns `denied` or `unauthorized`,
use `docker compose up --build` instead, or `docker login ghcr.io` with a token
that has `read:packages`. See
[docs/INSTALL.md](../docs/INSTALL.md#denied-or-unauthorized-when-pulling-the-image).

The app service has a healthcheck that polls `GET /health` every 30s using Node's built-in `fetch` (the `node:22-bookworm-slim` runtime image ships no curl/wget). `docker ps` shows the container as `healthy` once the server responds.

### Environment variables (self-host)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRINT_PARTNER_DATA_DIR` | `./data` | SQLite DB, repos, exports, thumbs |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `18765` (dev) / `8080` (Docker) | HTTP port |
| `STATIC_DIR` | unset | When set, serve built SPA from this directory |
| `DEPLOY_MODE` | `self-host` | `self-host` or `saas` |
| `CORS_ORIGIN` / `ALLOWED_ORIGINS` | `true` | CORS allowed origin(s); comma-separated list for multiple |
| `PP_VERSION` | `3.2.0-web` (baked into release images) | Health payload version |
| `PP_COMMIT` / `PP_TAG` / `PP_BUILD_DATE` | baked into release images | Read-only release provenance reported by `GET /health`; source builds report a development identity |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | unset | Optional HTTP Basic protection |
| `SINGLE_USER_AUTH` | `0` | Set to `1` to require login with one administrator account. The first registration claims existing self-host data. |
| `SESSION_SECRET` | unset | Not needed for single-user auth. Required when `MULTI_USER=1`. |
| `SESSION_COOKIE_SECURE` | `0` | Set to `1` when the self-hosted site is served through HTTPS. Leave at `0` for a plain HTTP LAN address. |
| `UPLOAD_MAX_BYTES` | `536870912` | Multipart upload limit (512 MiB) |
| `SOURCE_DOCS_MAX_BYTES` | `1073741824` | Per-source budget for synced markdown/PDF docs (~1 GiB). Operator escape hatch only. |
| `PRINT_PARTNER_API_KEY` | unset | When set, requires Bearer or `X-Print-Partner-Api-Key` on `/api/v1/*`. **Required for `/api/v1/mcp` unless `HOST` is loopback** (Docker uses `0.0.0.0`) |
| `OPENAPI_UI` | unset | Set to `1` to expose `/api/v1/docs` in production |
| `REDIS_URL` | unset | Optional; when set in SaaS, enables BullMQ job queue (see SaaS) |
| `PRINT_PARTNER_UPDATE_CHECK` | enabled | Set to `0` to disable in-app update checks |
| `GITHUB_REPO` | `poitee/PrintPartner` | GitHub repo for release lookup |
| `PRINT_PARTNER_LATEST_VERSION` | unset | Air-gapped override that skips GitHub and compares against this version |
| `PRINT_PARTNER_UPDATE_CHECK_CACHE_HOURS` | `12` | How long to cache the latest release lookup |
| `ASSISTANT_ALLOW_URL_INGEST` | enabled | Set to `0` to disable MCP `ingest_guide_url` / `fetch_web_page` |
| `ASSISTANT_GUIDE_INGEST_MAX_BYTES` | `524288` (512 KiB) | Max response body size for a single guide / page URL fetch |
| `PRINT_PARTNER_MCP_PLAN_ID` | unset | Optional default `plan_id` for MCP tools that omit it |
<!-- release-version:end -->

**URL ingest safety (MCP tools):** `ingest_guide_url`, `fetch_web_page`, and `web_search` use the same SSRF guard as cover/image fetches (`safeOutboundFetch`): HTTP(S) only, DNS-resolved, private/loopback/metadata blocked. Guide and search text is untrusted evidence; mutations require confirm-to-apply. There is no autonomous crawler.

### HTTP MCP (preferred on live host)

Streamable HTTP MCP is served by the running app at **`/api/v1/mcp`** (same product tools as stdio). Pending proposes are **per MCP session** (`mcp-session-id`).

**Fail-closed:** set **`PRINT_PARTNER_API_KEY`** whenever `HOST` is not loopback (Compose/`Dockerfile` bind `0.0.0.0`). Without a key on an exposed bind, `/api/v1/mcp` returns **503**. Auth header: Bearer or `X-Print-Partner-Api-Key`.

Use **HTTPS** for remote clients (terminate TLS at a reverse proxy). Plain `http://` is only for loopback or an authenticated tunnel.

```json
{
  "mcpServers": {
    "print-partner": {
      "url": "https://print-partner.example/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Cursor plugin: [`cursor-plugin/print-partner`](../cursor-plugin/print-partner). Full connect guide: [`docs/assistant-mcp.md`](../docs/assistant-mcp.md).

### Stdio MCP (DATA_DIR copy only)

Stdio opens SQLite directly. **Do not** point it at the live Docker volume while the app is running (two writers). Use a copy of `PRINT_PARTNER_DATA_DIR`, or stop the app.

```bash
cd web
export PRINT_PARTNER_DATA_DIR=./data-copy
export PRINT_PARTNER_MCP_PLAN_ID=1
npm run mcp -w @print-partner/server
```

Requires `DEPLOY_MODE=self-host` (default).

### Checking for app updates


When update checks are enabled (default), the server compares `PP_VERSION` to the latest [GitHub release](https://github.com/poitee/PrintPartner/releases) (cached ~12 hours). The web UI shows a dismissible banner when a newer version exists, and **Settings → About & updates** lists your version with a manual refresh.

Self-host Docker upgrade:

```bash
docker compose pull && docker compose up -d
```

Disable checks entirely with `PRINT_PARTNER_UPDATE_CHECK=0`. Offline or failed lookups never show an error banner.

### Releasing (maintainers)

<!-- release-version:start -->
Prepare every version-bearing file with the release command, review the dry
run, and commit the result:

```bash
node scripts/release.mjs prepare 3.2.0 --dry-run
node scripts/release.mjs prepare 3.2.0
git add CHANGELOG.md Dockerfile README.md OPERATIONS.md docker-compose.yml web/package.json web/package-lock.json web/DEPLOY.md
git commit -m "chore(release): prepare v3.2.0"
node scripts/release.mjs check
git tag -a v3.2.0 -m "Release v3.2.0"
git push origin main
git push origin v3.2.0
```

The `release.yml` workflow first requires the complete web quality suite,
high-severity dependency audit, production Docker smoke test, and manifest
schema/drift validation. It peels the annotated tag to its commit, checks every
version sink, and builds a multi-arch candidate image (`linux/amd64` and
`linux/arm64`) with matching OCI metadata. CI then attaches a digest-pinned
`release-identity.json` to the GitHub Release, creates or verifies the immutable
`:3.2.0` alias, verifies the public identity, and moves `:latest` last as a
convenience alias. A conflicting existing candidate, release asset, or version
alias fails instead of being overwritten.
<!-- release-version:end -->

GHCR package visibility is a one-time package setting, not a release step. The
historical `v3.1.0` tag points to disconnected history and its workflow pushed
an image before failing to create a GitHub Release. Do not move, delete, or
reuse that tag. `v3.2.0` is the first release prepared under the repaired
identity contract.

### Local development

```bash
cd web
npm ci
npm run dev   # predev builds @print-partner/contracts and @print-partner/domain first
```

API: `http://127.0.0.1:18765` · Vite UI: `http://127.0.0.1:5173`

The versioned integration API is available at `http://127.0.0.1:18765/api/v1`. See [`../docs/API.md`](../docs/API.md). Connect optional [Spoolman](../docs/integrations/SPOOLMAN.md) filament inventory in **Settings > Integrations**.

## SaaS mode (`DEPLOY_MODE=saas`)

SaaS mode can use **Postgres for app data** when `DATABASE_URL` is set (tenant-scoped rows). The current Postgres repository runs through a synchronous compatibility bridge and is **experimental, not production-ready**: it does not provide native transaction semantics for repository mutations. Production startup fails closed unless `POSTGRES_EXPERIMENTAL=1` explicitly acknowledges this limitation. SQLite remains the supported database. `GET /health` reports `db.support_status` as `supported` or `experimental`.

The bridge also depends on Drizzle's private prepared-field metadata and
`drizzle-orm/utils` result mapper. Dependency updates must pass
`sync-db-bridge.test.ts` and the live Postgres smoke before release. Each
synchronous query is limited to 10,000 returned rows and an 8 MiB serialized
result; callers must paginate larger reads. These ceilings keep the
child-process protocol bounded and produce an explicit error instead of an
implicit stdout-buffer failure.

File blobs (repos, exports, thumbs) stay on disk under `SAAS_DATA_DIR` unless `S3_BUCKET` is configured.

### Quick local SaaS stack

```bash
docker compose -f docker-compose.saas.yml up --build
```

Includes Postgres 16, [RustFS](https://rustfs.com) (S3-compatible), and the app with `SAAS_ALLOW_ANONYMOUS=1` and `MULTI_USER=0` for easy dev. The compose file creates the `print-partner` bucket on first start.

The Compose credentials are explicitly development-only defaults. Before using
the stack on any shared network, set strong values for
`PP_DEV_POSTGRES_PASSWORD`, `PP_DEV_S3_ACCESS_KEY`, and
`PP_DEV_S3_SECRET_KEY`, and `PP_DEV_SESSION_SECRET`. Ports bind to
`127.0.0.1` by default; set `PP_BIND_ADDRESS` explicitly only when a firewall
and authentication protect the shared interface.

**Migrating from MinIO:** remove the old `pp-minio` volume (`docker volume rm <project>_pp-minio`). RustFS uses a different on-disk format. Blob data in the old volume is not portable, so re-upload or re-sync sources after switching.

### SaaS environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOY_MODE` | Yes | Set to `saas` |
| `SAAS_DATA_DIR` | Recommended | Repos, exports, thumbs scratch dir (default `./data`) |
| `DATABASE_URL` | Experimental | Postgres connection string; runs migrations on startup and requires explicit experimental opt-in in production |
| `POSTGRES_EXPERIMENTAL` | With production Postgres | Set `1` to acknowledge that the sync bridge is experimental and lacks native repository transactions |
| `S3_BUCKET` | Optional | Tenant-prefixed S3 blobs |
| `S3_REGION` / `AWS_REGION` | With S3 | AWS region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | With S3 | S3 credentials (the RustFS development stack reads `PP_DEV_S3_ACCESS_KEY` / `PP_DEV_S3_SECRET_KEY`) |
| `S3_ENDPOINT` | S3-compatible dev | Custom S3 endpoint URL (e.g. `http://rustfs:9000`) |
| `S3_FORCE_PATH_STYLE` | S3-compatible dev | Set `1` for path-style URLs (RustFS, MinIO, Garage, etc.) |
| `MULTI_USER` | Optional | `1` enables multiple accounts and sharing; first registered user claims existing data |
| `SINGLE_USER_AUTH` | Optional | `1` enables one self-host administrator account without multi-user sharing |
| `SESSION_SECRET` | Multi-user / OAuth / prod | Not needed for `SINGLE_USER_AUTH=1`. Supply it for `MULTI_USER=1` or OAuth in production. |
| `PP_BIND_ADDRESS` | Compose only | Host bind for app/Postgres/RustFS ports; defaults to loopback (`127.0.0.1`) |
| `PP_DEV_MULTI_USER` / `PP_DEV_SESSION_SECRET` | Development Compose | Override the single-user mode and development-only session secret |
| `ALLOWED_ORIGINS` | Prod | Comma-separated CORS origins (alias: `CORS_ORIGIN`) |
| `SAAS_BASIC_AUTH` | Optional | `user:password` for HTTP Basic dev auth |
| `GITHUB_CLIENT_ID` / `SECRET` / `GITHUB_CALLBACK_URL` | OAuth | GitHub OAuth app |
| `DISCORD_CLIENT_ID` / `SECRET` / `DISCORD_CALLBACK_URL` | OAuth | Discord OAuth app (`/auth/discord/callback`) |
| `GOOGLE_CLIENT_ID` | Optional | Public Google OAuth **Web** client id for parts-manifest Drive open/save (SPA GIS + Drive API). Not a secret; exposed on `GET /health`. Enable Drive API and add your app origin to Authorized JavaScript origins. Dev SPA fallback: `VITE_GOOGLE_CLIENT_ID`. |
| `SAAS_ALLOW_ANONYMOUS` | Optional | `1` to allow unauthenticated API (dev only) |
| `REDIS_URL` | Optional | BullMQ-backed job queue for horizontal scaling |
| `UPLOAD_MAX_BYTES` | Optional | Request body / upload size limit |

### Auth routes

| Route | Description |
|-------|-------------|
| `GET /auth/github` | Start GitHub OAuth |
| `GET /auth/callback` | GitHub OAuth callback |
| `GET /auth/discord` | Start Discord OAuth |
| `GET /auth/discord/callback` | Discord OAuth callback |
| `POST /auth/register` | Email + password registration; single-user mode closes registration after its administrator exists |
| `POST /auth/login` | Email + password login |
| `POST /auth/forgot-password` | Request a password reset email |
| `POST /auth/reset-password` | Set a new password using a reset token |
| `POST /auth/change-password` | Change password while signed in |
| `POST /auth/logout` | Clear session |
| `GET /auth/me` | Current user + tenant |
| `POST /auth/dev-login` | Dev session helper |
| `POST /plans/:id/shares` | Send build copy to another user |
| `GET /shares/incoming` | List pending shares for current user |
| `POST /shares/:token/accept` | Import shared build as new plan |
| `DELETE /shares/:id` | Revoke a pending share |

### Password reset email (multi-user)

When `MULTI_USER=1`, users can reset forgotten passwords from **Sign in > Forgot password?** or `POST /auth/forgot-password`.

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | For email delivery | SMTP server hostname |
| `SMTP_PORT` | Optional | Default `587` (`465` implies TLS) |
| `SMTP_USER` / `SMTP_PASS` | Optional | SMTP credentials when required by your provider |
| `SMTP_FROM` | With `SMTP_HOST` | From address (e.g. `Print Partner <noreply@example.com>`) |
| `SMTP_SECURE` | Optional | Set `1` for implicit TLS (typical on port 465) |
| `APP_PUBLIC_URL` | Recommended | Public app URL for reset links (e.g. `https://print.example.com`). Without this, the link uses the incoming request `Host` header. |
| `PASSWORD_RESET_DEV_EXPOSE` | Dev only | When SMTP is not configured, non-production mode returns `dev_reset_url` in the API response and logs the link. Set `0` to disable. |

Without SMTP in production, reset requests are accepted but no email is sent. Configure SMTP for production deployments.

### Data migration from desktop

```bash
cd web
npx tsx scripts/import-sqlite.ts \
  --source-db ~/.print-partner/print-partner.db \
  --source-repos ~/.print-partner/repos \
  --dest ./data
```

### Exports and imports (web / Docker)

- **Exports:** job endpoints write files under `exports/` in the data dir and return `download_url` (e.g. `/exports/Plan/checklist.html`). The UI triggers a browser download via `GET /exports/*` with `Content-Disposition: attachment`.
- **Kit bundle import (browser):** upload `.print-partner-kit.zip` with `POST /imports/kit-bundle` (multipart field `file`). Command palette **Import shared build...** uses this path.
- **Kit bundle import (server host):** `POST /admin/import-kit-bundle` with `{ "path": "..." }` when the `.print-partner-kit` file already exists under the data directory (admin scripts on the same machine as the engine).
- **Source ZIP import:** `POST /sources/:id/upload-zip` (multipart upload only).

### Smoke test

Run `npm run quality` before deploying a changed image.

## Known gaps

- No PyVista/VTK mesh preview server-side (client thumbnails only)
- Printables/MakerWorld source create returns `501`
- Community manifest report issue action uses an export-draft stub body
- Bambu metadata in 3MF is minimal (plate JSON + slice_info stub)
