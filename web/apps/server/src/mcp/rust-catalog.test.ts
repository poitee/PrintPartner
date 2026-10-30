/**
 * The Rust MCP catalog (GRE-441) must equal what this server lists.
 *
 * rust/crates/pp-services/src/mcp_domain/catalog.json is exported from the
 * live product MCP server, descriptions included. A tool, prompt or resource
 * change here fails this test until the catalog is regenerated:
 *
 *   npx tsx --conditions=development scripts/export-mcp-catalog.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUST_CATALOG_PATH, renderMcpCatalog } from "./rust-catalog.js";

describe("Rust MCP catalog", () => {
  it("matches the live Node tools, prompts and resources byte for byte", async () => {
    const committed = readFileSync(RUST_CATALOG_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(await renderMcpCatalog()).toBe(committed);
  });
});
