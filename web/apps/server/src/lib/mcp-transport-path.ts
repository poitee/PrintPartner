/**
 * Exact Streamable HTTP MCP route. POST, GET, and DELETE on `/api/v1/mcp` qualify.
 * Sub-paths and sibling routes do not.
 *
 * `registerTenantMiddleware` skips its session requirement for this route only
 * when the process is self-host single-user auth. Multi-user requests keep the
 * session requirement. This helper does not accept or reject a credential.
 */

const MCP_HTTP_PATH = "/api/v1/mcp";

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
