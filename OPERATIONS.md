# Operations

This guide covers the supported self-host Docker deployment. See [Install](docs/INSTALL.md) for first-time setup and [Deployment reference](web/DEPLOY.md) for all environment variables.

## Check the service

```bash
docker compose ps
docker compose logs --tail 100 print-partner
curl --fail --silent http://127.0.0.1:8080/health | jq .
```

<!-- release-version:start -->
A healthy `3.2.0` deployment reports runtime version `3.2.0-web` and a release tag of `v3.2.0`.
<!-- release-version:end -->

The health response also reports the database driver and connection state. Treat a failed database check as unavailable service, even when the container remains running.

## Authenticate administrative requests

Local loopback requests may use the trusted self-host shortcut. Remote and reverse-proxied requests should send an API key:

```bash
export PP_API_KEY='replace-with-your-key'
curl --fail \
  -H "Authorization: Bearer $PP_API_KEY" \
  https://print-partner.example/api/v1
```

All current API keys have administrator authority. Store them as secrets and issue separate keys when independent revocation matters.

## Back up data

Create a server-side backup:

```bash
curl --fail --silent -X POST http://127.0.0.1:8080/backups | jq .
```

List stored backups:

```bash
curl --fail --silent http://127.0.0.1:8080/backups | jq .
```

Download one archive:

```bash
export PP_BACKUP_NAME='print-partner-backup-2026-08-22T12-00-00-000Z.tar.gz'
curl --fail \
  "http://127.0.0.1:8080/backups/$PP_BACKUP_NAME" \
  --output "$PP_BACKUP_NAME"
```

The server stores its backup archives under `/data/backups`. Keep another copy outside the Docker volume. A backup stored only beside the live database does not protect against volume loss.

Back up before upgrades, major imports, or storage changes.

## Restore a backup

List backups and choose the exact stored filename. Restoring replaces current application data.

```bash
export PP_BACKUP_NAME='print-partner-backup-2026-08-22T12-00-00-000Z.tar.gz'
curl --fail -X POST http://127.0.0.1:8080/backups/restore \
  -H 'Content-Type: application/json' \
  --data "{\"backupName\":\"$PP_BACKUP_NAME\"}"
```

Restart the service after restore, then check health and application state:

```bash
docker compose restart print-partner
curl --fail --silent http://127.0.0.1:8080/health | jq .
```

Test restore procedures on a disposable copy before depending on them for recovery.

## Update

Read [CHANGELOG.md](CHANGELOG.md), create a backup, then update:

```bash
git pull --ff-only
docker compose pull
docker compose up -d
```

Watch startup and migration logs:

```bash
docker compose logs -f print-partner
```

Confirm the reported version and open an existing Build before considering the upgrade complete.

If you build locally:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

## Roll back

A database migration may make old application code incompatible with new data. Do not roll back only the image.

1. stop the service
2. select the previous image version
3. restore a backup created by that version
4. start the service
5. verify health and a representative Build

Keep versioned images and matching backups until the upgrade has been proven.

## Logs

Container logs:

```bash
docker compose logs --tail 200 print-partner
docker compose logs -f print-partner
```

Application workflow logs:

```bash
curl --fail --silent http://127.0.0.1:8080/settings/logging/stats | jq .
curl --fail --silent 'http://127.0.0.1:8080/settings/logging/logs?limit=100' | jq .
curl --fail --silent -X POST \
  'http://127.0.0.1:8080/settings/logging/export?format=jsonl' \
  --output print-partner-logs.jsonl
```

Clear in-memory workflow logs only after exporting anything you need:

```bash
curl --fail -X DELETE http://127.0.0.1:8080/settings/logging/logs
```

Review exported logs for filenames, resource ids, and other sensitive context before sharing them.

## API keys

Create a key:

```bash
curl --fail --silent -X POST http://127.0.0.1:8080/settings/api-keys | jq .
```

The plaintext key appears once. Store it before closing the response.

List keys:

```bash
curl --fail --silent http://127.0.0.1:8080/settings/api-keys | jq .
```

Rotate or revoke a key by id:

```bash
export PP_KEY_ID='key-id'
curl --fail --silent -X POST \
  "http://127.0.0.1:8080/settings/api-keys/$PP_KEY_ID/regenerate" | jq .
curl --fail -X DELETE \
  "http://127.0.0.1:8080/settings/api-keys/$PP_KEY_ID"
```

## Metrics

Prometheus metrics are available at `/metrics`:

```bash
curl --fail http://127.0.0.1:8080/metrics
```

Remote deployments may require a session or API key. Protect metrics at the same network boundary as the application.

Monitor at least:

- health check failures
- HTTP error rate
- remaining disk space under `/data`
- backup age
- printer integration failures
- Build and printer workload gauges relevant to your shop

## Disk and volume checks

```bash
docker compose exec print-partner du -sh /data
docker volume inspect print-partner-data
```

Large consumers are usually synced repositories, thumbnails, exports, and backup archives. Download old backups before deleting their server-side copies.

The default image prepares `/data` as root, then runs Node as uid 1000. Do not add a fixed `user:` setting unless a bind mount has already been prepared for that uid.

Verify the app process:

```bash
docker top "$(docker compose ps -q print-partner)" -eo uid,user,pid,cmd
```

## SQLite integrity

Create a backup before manual database work. The production image may not include the SQLite CLI, so run integrity checks from a maintenance container or a host tool against an offline copy.

Never point two application processes at the same SQLite database. This includes the stdio MCP server and ad hoc migration scripts.

## Common failures

### Container does not start

Check the Compose status and logs. Common causes are a port conflict, invalid environment value, failed database migration, or `/data` permissions.

### Permission denied under `/data`

Remove a `user:` override from the default named-volume setup. For a bind mount, stop the container and set the directory owner to uid 1000 before restarting.

### Image pull is denied

Build from source with `docker compose up --build -d` while registry access is unavailable.

### Printer or Spoolman is unreachable

Test the destination from the Docker host. Confirm VLAN routing, firewall rules, DNS, and the address visible from inside the container. See [Printer setup](docs/integrations/PRINTER_SETUP.md) and [Spoolman](docs/integrations/SPOOLMAN.md).

### A browser path returns JSON

Check the reverse proxy. Browser document navigation must preserve `Sec-Fetch-Mode: navigate` or an `Accept` header containing `text/html`.

## Incident response

For suspected compromise:

1. remove public access or stop the container
2. preserve container logs and an offline copy of `/data`
3. revoke API keys and rotate integration credentials
4. inspect user accounts, webhooks, OAuth settings, and printer hosts
5. restore from a known backup if state changed
6. update and verify before reconnecting the service

See [Security](SECURITY.md) for the reporting process and hardening guidance.
