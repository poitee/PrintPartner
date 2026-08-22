/**
 * Thin stdio MCP server exposing Print Partner product verbs.
 *
 * Reuses ASSISTANT_TOOL_SPECS / invokeAssistantTool / applyAssistantAction.
 * Mutating tools only propose; call confirm_apply (or dismiss_proposed_action)
 * for the same confirm-to-apply semantics as Apply cards.
 *
 * Prefer HTTP MCP on the live Docker host (`/api/v1/mcp` + PRINT_PARTNER_API_KEY).
 * Stdio against a live Docker volume races the app (two SQLite writers) —
 * use a DATA_DIR copy, or stop the app, for Claude Desktop stdio until HTTP is used.
 *
 * Run (from web/): npm run mcp -w @print-partner/server
 * See docs/assistant-mcp.md.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { loadConfig } from "../config.js";
import { createPorts } from "../app.js";
import { createJobRunner, type InProcessJobRunner } from "../routes/jobs.js";
import type { AppRepository } from "../db/repository.js";
import { createProductMcpServer } from "./product-mcp.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.deployMode !== "self-host") {
    console.error(
      "Print Partner MCP currently targets self-host (SQLite). Set DEPLOY_MODE=self-host.",
    );
    process.exit(1);
  }

  const ports = createPorts(config);
  await ports.db.connect();

  const getRepo = (): AppRepository => {
    if (ports.repository) return ports.repository;
    if (ports.getRepository) return ports.getRepository("default");
    throw new Error("No repository available");
  };

  const jobs: InProcessJobRunner = createJobRunner(getRepo, config.dataDir);
  const pending = new Map<string, AssistantProposedAction>();

  const planEnv = process.env.PRINT_PARTNER_MCP_PLAN_ID;
  const defaultPlanId =
    planEnv && Number.isFinite(Number(planEnv)) ? Math.trunc(Number(planEnv)) : null;

  const server = createProductMcpServer({
    getRepo,
    jobs,
    config,
    defaultPlanId,
    pending,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `print-partner-assistant MCP on stdio (data=${config.dataDir}` +
      `${defaultPlanId != null ? `, plan=${defaultPlanId}` : ""})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
