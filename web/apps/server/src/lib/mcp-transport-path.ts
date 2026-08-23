/**
 * The Streamable HTTP MCP transport route.
 *
 * MCP clients authenticate with a bearer API key, not a browser session, so the
 * tenant middleware lets these exact requests past its session gate. The API-key
 * hook (middleware/api-key.ts) and `assertMcpHttpAllowed` (mcp/http-routes.ts)
 * remain the authoritative checks — nothing here grants access.
 */

export const MCP_HTTP_PATH = "/api/v1/mcp";

/** Methods the transport actually serves; anything else stays session-gated. */
const MCP_HTTP_METHODS = new Set(["GET", "POST", "DELETE"]);

function requestPathname(url: string): string {
  const path = url.split("?", 1)[0] ?? url;
  return path.split("#", 1)[0] ?? path;
}

/**
 * True only for the exact MCP transport route. Sub-paths (`/api/v1/mcp/other`)
 * and sibling routes never qualify.
 */
export function isMcpTransportRequest(method: string, url: string): boolean {
  if (requestPathname(url) !== MCP_HTTP_PATH) return false;
  return MCP_HTTP_METHODS.has(method.toUpperCase());
}
