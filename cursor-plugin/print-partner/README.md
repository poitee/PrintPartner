# Print Partner Cursor plugin

This plugin connects Cursor to a running Print Partner host over streamable HTTP MCP.

## Install

1. Add this directory from Cursor's plugin settings.
2. Set `PRINT_PARTNER_MCP_URL` to the full `https://<host>/api/v1/mcp` URL.
3. Set `PRINT_PARTNER_API_KEY` to the deployment key on a single-tenant host. A multi-user host requires a login session. A bearer key on its own is rejected there.
4. Enable the `print-partner` MCP server.

Use `http://127.0.0.1:8080/api/v1/mcp` only when Cursor and Print Partner share the same computer or an authenticated tunnel.

See [MCP setup](../../docs/assistant-mcp.md) for security notes, manual configuration, and tool behavior.
