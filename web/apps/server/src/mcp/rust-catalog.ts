/**
 * Rust MCP catalog (GRE-441, parity tooling; the server never calls this).
 *
 * Renders what a client sees before any tool runs, from the REAL product MCP
 * server: server info, tools/list (with descriptions, farm tools listed),
 * prompts/list, the plan_build prompt, resources/list and
 * resources/templates/list. The Rust core embeds the result as
 * rust/crates/pp-services/src/mcp_domain/catalog.json, and
 * rust-catalog.test.ts fails when the two differ.
 *
 * The plan_build prompt is fetched with customer_request set to a literal
 * placeholder; the Rust core substitutes the caller's text for it.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { createProductMcpServer } from "./product-mcp.js";

export const RUST_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../rust/crates/pp-services/src/mcp_domain/catalog.json",
);
const CUSTOMER_REQUEST_PLACEHOLDER = "{{customer_request}}";

/** The catalog file text, exactly as the Rust core embeds it. */
export async function renderMcpCatalog(): Promise<string> {
  // Farm tools are listed only when farm access is allowed; with the desktop
  // flag off that needs no repository read, so the catalog holds all tools.
  const desktopFlag = process.env.PP_DESKTOP_REBUILD;
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
    return `{\n${lines.join(",\n")}\n}\n`;
  } finally {
    await client.close();
    await server.close();
    if (desktopFlag !== undefined) process.env.PP_DESKTOP_REBUILD = desktopFlag;
  }
}
