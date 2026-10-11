/**
 * MCP tool inventory golden (test/CI only).
 *
 * Connects an in-memory MCP client to the REAL product MCP server
 * (createProductMcpServer — the same server behind stdio and /api/v1/mcp),
 * calls tools/list, and writes each tool's name and input schema to
 * fixtures/mcp/tools-inventory.json. Descriptions are left out so wording
 * edits do not churn the golden; names and argument shapes are the contract.
 *
 * tools/list touches no deps, so the repo/jobs/config stubs are never read.
 * No database, network, or printer is involved.
 *
 * CI regenerates this file and fails on `git diff`. After an intentional tool
 * change, regenerate and commit:
 *
 *   npm run mcp:inventory -w @print-partner/server
 *
 * Usage: tsx scripts/export-mcp-tools-inventory.ts [outFile]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { createProductMcpServer } from "../src/mcp/product-mcp.js";

const DEFAULT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mcp/tools-inventory.json",
);

/** Recursively sort object keys so the golden is stable across key-order churn. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

async function main(): Promise<void> {
  const outFile = resolve(process.argv[2] ?? DEFAULT_OUT);

  const server = createProductMcpServer({
    getRepo: () => {
      throw new Error("tools/list must not read the repository");
    },
    jobs: {} as never,
    config: {} as never,
    pending: new Map<string, AssistantProposedAction>(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-tools-inventory", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools, nextCursor } = await client.listTools();
    if (nextCursor) throw new Error("tools/list paginated; inventory export expects one page");

    const names = tools.map((t) => t.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    if (duplicates.length) throw new Error(`duplicate MCP tool names: ${duplicates.join(", ")}`);

    const inventory = {
      server: client.getServerVersion() ?? null,
      toolCount: tools.length,
      tools: [...tools]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((t) => ({ name: t.name, inputSchema: sortKeys(t.inputSchema) })),
    };

    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`wrote ${inventory.toolCount} MCP tools to ${outFile}`);
  } finally {
    await client.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
