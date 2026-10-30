/**
 * Rust MCP catalog export (GRE-441, test/parity only).
 *
 * Connects an in-memory MCP client to the REAL product MCP server and writes
 * what a client sees before any tool runs: server info, tools/list (with
 * descriptions, farm tools listed), prompts/list, the plan_build prompt,
 * resources/list and resources/templates/list. The Rust core serves this file
 * as its catalog (rust/crates/pp-services/src/mcp_domain/catalog.json).
 *
 * Parity check: regenerate, then `git diff --exit-code` on the catalog.
 *
 *   npx tsx --conditions=development scripts/export-mcp-catalog.ts
 *
 * The plan_build prompt is fetched with customer_request set to the literal
 * placeholder below; the Rust core substitutes the caller's text for it.
 *
 * Usage: tsx scripts/export-mcp-catalog.ts [outFile]
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
  "../../../../rust/crates/pp-services/src/mcp_domain/catalog.json",
);
const CUSTOMER_REQUEST_PLACEHOLDER = "{{customer_request}}";

async function main(): Promise<void> {
  const outFile = resolve(process.argv[2] ?? DEFAULT_OUT);
  // Farm tools are listed only when farm access is allowed; with the desktop
  // flag off that needs no repository read, so the catalog holds all tools.
  delete process.env.PP_DESKTOP_REBUILD;

  const server = createProductMcpServer({
    getRepo: () => {
      throw new Error("catalog export must not read the repository");
    },
    jobs: {} as never,
    config: {} as never,
    statusExecution: {} as never,
    pending: new Map<string, AssistantProposedAction>(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-catalog-export", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools, nextCursor } = await client.listTools();
    if (nextCursor) throw new Error("tools/list paginated; catalog export expects one page");
    const catalog = {
      server: client.getServerVersion() ?? null,
      capabilities: client.getServerCapabilities() ?? null,
      tools,
      prompts: (await client.listPrompts()).prompts,
      plan_build_prompt: await client.getPrompt({
        name: "plan_build",
        arguments: { customer_request: CUSTOMER_REQUEST_PLACEHOLDER },
      }),
      resources: (await client.listResources()).resources,
      resource_templates: (await client.listResourceTemplates()).resourceTemplates,
    };
    // One top-level key per line and one array entry per line keeps the file
    // diffable per tool without a 2,000-line pretty print.
    const lines = Object.entries(catalog).map(([key, value]) =>
      Array.isArray(value)
        ? `  ${JSON.stringify(key)}: [\n${value.map((v) => `    ${JSON.stringify(v)}`).join(",\n")}\n  ]`
        : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
    );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `{\n${lines.join(",\n")}\n}\n`);
    console.log(`wrote ${tools.length} MCP tools to ${outFile}`);
  } finally {
    await client.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
