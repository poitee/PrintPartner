# MCP

Print Partner exposes product operations to AI assistants over the Model Context Protocol. This page will describe the MCP server in the Rust core. It is a stub until the API milestone ports MCP from Node.

[MCP setup](assistant-mcp.md) describes how to connect a client to the current Node server.

## Rules the Rust port keeps

- MCP runs over streamable HTTP at `/api/v1/mcp`.
- Every request needs an API key, including requests from the same machine.
- Read tools return current data. Write tools return a proposal and change nothing until the client calls `confirm_apply`.
- Tool names and schemas stay the same, so existing clients keep working.

## To be written

- How to create and rotate the API key in the desktop app and the Docker image.
- How MCP access works when network sharing is on.
- The tool list and its schemas.
