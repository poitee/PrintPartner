# Connect an MCP client

Print Partner exposes its source, Build, Plan, and Checkoff operations over streamable HTTP MCP. Read tools return current product state. Write tools create a pending proposal that must be accepted with `confirm_apply`.

## Before you connect

Set an API key on the Print Partner host:

```yaml
services:
  print-partner:
    environment:
      PRINT_PARTNER_API_KEY: replace-with-a-long-random-value
```

Restart the container:

```bash
docker compose up -d
```

Use one of these endpoints:

| Connection | URL |
|------------|-----|
| On the Docker host | `http://127.0.0.1:8080/api/v1/mcp` |
| Remote through HTTPS | `https://<your-host>/api/v1/mcp` |

The MCP endpoint refuses a non-loopback deployment without an API key. Use HTTPS or an authenticated tunnel when the client is on another machine.

## Generic client configuration

Clients that support streamable HTTP MCP can use:

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

Replace the URL and key with values for your host. Keep the key out of source control.

## Cursor plugin

The repository includes a plugin in [`cursor-plugin/print-partner`](../cursor-plugin/print-partner).

Configure these plugin variables:

| Variable | Value |
|----------|-------|
| `PRINT_PARTNER_MCP_URL` | The full `/api/v1/mcp` URL |
| `PRINT_PARTNER_API_KEY` | The key configured on the host |

Enable the `print-partner` MCP server after setting both values.

## Stdio for an offline data copy

The server package also contains a stdio transport. Use it only when Print Partner is stopped or when the client points to a copy of the data directory. Two processes must not write to the same live SQLite database.

```bash
cd web
export PRINT_PARTNER_DATA_DIR=/path/to/data-copy
export PRINT_PARTNER_MCP_PLAN_ID=1
npm run mcp -w @print-partner/server
```

Example stdio configuration:

```json
{
  "mcpServers": {
    "print-partner-offline": {
      "command": "npm",
      "args": ["run", "mcp", "-w", "@print-partner/server"],
      "cwd": "/path/to/PrintPartner/web",
      "env": {
        "PRINT_PARTNER_DATA_DIR": "/path/to/data-copy",
        "DEPLOY_MODE": "self-host"
      }
    }
  }
}
```

`PRINT_PARTNER_MCP_PLAN_ID` is optional. It selects a default Build for tools that accept a Plan id.

## Tool behavior

Common tools include:

| Tool | Purpose |
|------|---------|
| `list_sources` | List synced Library sources. |
| `list_plans` | List Builds. |
| `get_plan_snapshot` | Read layers and kit selections. |
| `get_plan_review` | Read quantities and warnings. |
| `get_remaining` | Read printed and remaining units. |
| `duplicate_plan` | Propose a Build copy. |
| `archive_plan` | Propose archiving a finished Build. |
| `list_pending_actions` | List proposals in the current MCP session. |
| `confirm_apply` | Apply one pending proposal. |
| `dismiss_proposed_action` | Discard one pending proposal. |

Pending proposals belong to the MCP session that created them. A reconnect may start a new session.

Print Partner does not expose a tool that starts a print without a separate product confirmation flow.

## Test the endpoint

Check the application first:

```bash
curl http://127.0.0.1:8080/health
```

If a remote MCP connection fails, verify:

1. the URL ends with `/api/v1/mcp`
2. the header uses the same key configured on the host
3. the reverse proxy allows `POST`, `GET`, and `DELETE`
4. the proxy does not buffer or time out streaming responses
5. the host certificate is valid for the client
