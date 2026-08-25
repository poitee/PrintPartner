import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { createPorts } from "../app.js";
import { loadConfig } from "../config.js";
import type { AppRepository } from "../db/repository.js";
import { createJobRunner } from "../routes/jobs.js";
import { createProductMcpServer } from "./product-mcp.js";

const request = `Build an Example Printer R2 350mm using the upstream repository as the structural base and the vendor repository as the vendor-kit overlay. Use the Example Toolhead, Example Extruder, Example Hotend, Example Probe over USB, and an Example Controller with a USB umbilical. Primary color is Forest Green and accent color is Bright Orange. Do not choose between conflicting source files without asking me.`;

// Replace with the two repos you want the demo to reason about.
const urls = [
  "https://github.com/ExampleOrg/Example-Printer",
  "https://github.com/ExampleVendor/Example-Printer-Kit",
];

function text(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first: unknown = content[0];
  if (!first || typeof first !== "object" || !("text" in first)) return "";
  return String(first.text);
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "print-partner-build-planning-"));
  process.env.PRINT_PARTNER_DATA_DIR = dataDir;
  process.env.HOST = "127.0.0.1";
  const config = loadConfig();
  const ports = createPorts(config);
  await ports.db.connect();
  const getRepo = (): AppRepository => {
    if (ports.repository) return ports.repository;
    if (ports.getRepository) return ports.getRepository("default");
    throw new Error("Repository unavailable");
  };
  const pending = new Map<string, AssistantProposedAction>();
  const jobs = createJobRunner(getRepo, config.dataDir);
  const server = createProductMcpServer({
    getRepo,
    jobs,
    config,
    pending,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "build-planning-demo", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const prompts = await client.listPrompts();
    const resources = await client.listResourceTemplates();
    const analysis = await client.callTool({
      name: "analyze_build_request",
      arguments: { request, urls },
    });
    const proposal = await client.callTool({
      name: "propose_create_build",
      arguments: { name: "Example Printer R2 350", request, urls, idempotency_key: "demo-example-r2-350" },
    });
    const proposed = JSON.parse(text(proposal)) as { action: { id: string } };
    const beforeConfirm = await client.callTool({ name: "list_plans", arguments: {} });
    const confirmed = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: proposed.action.id },
    });
    const applied = JSON.parse(text(confirmed)) as { result: { plan_id: number } };
    const buildId = applied.result.plan_id;
    const importProposal = await client.callTool({
      name: "propose_import_build_inputs",
      arguments: { plan_id: buildId, inputs: urls.map((url) => ({ url })) },
    });
    const importAction = JSON.parse(text(importProposal)) as { action: { id: string } };
    const imported = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: importAction.action.id },
    });
    const importedResult = JSON.parse(text(imported)) as {
      result: { source_ids: number[] };
    };
    const repeatProposal = await client.callTool({
      name: "propose_import_build_inputs",
      arguments: { plan_id: buildId, inputs: urls.map((url) => ({ url })) },
    });
    const repeatAction = JSON.parse(text(repeatProposal)) as { action: { id: string } };
    const repeatedImport = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: repeatAction.action.id },
    });
    const syncProposal = await client.callTool({
      name: "start_sync",
      arguments: { plan_id: buildId, project_ids: importedResult.result.source_ids },
    });
    const syncAction = JSON.parse(text(syncProposal)) as { action: { id: string } };
    const syncStarted = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: syncAction.action.id },
    });
    const syncResult = JSON.parse(text(syncStarted)) as { job_id: string };
    const deadline = Date.now() + 180_000;
    let syncJob = jobs.listJobs({}, "default").find((job) => job.job_id === syncResult.job_id);
    while (syncJob && (syncJob.status === "pending" || syncJob.status === "running") && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      syncJob = jobs.listJobs({}, "default").find((job) => job.job_id === syncResult.job_id);
    }
    const state = await client.callTool({
      name: "get_build_planning_state",
      arguments: { plan_id: buildId },
    });
    const resource = await client.readResource({
      uri: `print-partner://build-planning/${buildId}`,
    });

    const planningState = JSON.parse(text(state));
    process.stdout.write(`${JSON.stringify({
      discovery: {
        prompts: prompts.prompts.map((prompt) => prompt.name),
        resources: resources.resourceTemplates.map((template) => template.uriTemplate),
      },
      analysis: JSON.parse(text(analysis)),
      confirmation: {
        plans_before_confirm: JSON.parse(text(beforeConfirm)).plans,
        applied,
        imported: JSON.parse(text(imported)),
        repeated_import: JSON.parse(text(repeatedImport)),
        sync_job: syncJob,
      },
      planning_state: {
        evidence: planningState.brief.evidence,
        readiness: planningState.readiness,
        grouped_difference_count: planningState.grouped_difference_count,
        difference_count: planningState.difference_count,
        first_differences: planningState.brief.differences.slice(0, 10),
      },
      resource_matches_tool:
        resource.contents[0] && "text" in resource.contents[0]
          ? JSON.parse(resource.contents[0].text).brief.build_id === buildId
          : false,
    }, null, 2)}\n`);
  } finally {
    await client.close();
    await server.close();
    await ports.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main();
