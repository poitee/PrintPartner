/**
 * Writes the Rust MCP catalog (GRE-441) from the live product MCP server.
 * See src/mcp/rust-catalog.ts. Regenerate after an intentional MCP change:
 *
 *   npm run mcp:catalog -w @print-partner/server
 *
 * Usage: tsx scripts/export-mcp-catalog.ts [outFile]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RUST_CATALOG_PATH, renderMcpCatalog } from "../src/mcp/rust-catalog.js";

async function main(): Promise<void> {
  const outFile = resolve(process.argv[2] ?? RUST_CATALOG_PATH);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, await renderMcpCatalog());
  console.log(`wrote MCP catalog to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
