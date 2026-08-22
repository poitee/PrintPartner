/**
 * Regression: the product MCP server must give farm tools a live
 * IntegrationPort.
 *
 * get_farm_status reads printer state through ctx.integrations. The MCP
 * server built its ToolContext without that field, so every printer came back
 * `state: "unknown"` over MCP even while the REST status route reported them
 * idle/printing — which silently degraded the morning Discord digest to
 * "everything offline". These tests pin the wiring.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { loadConfig } from "../config.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { InProcessJobRunner } from "../routes/jobs.js";
import { saveFleet } from "../services/printer-fleet.js";
import { getLogger } from "../services/logger.js";
import type { IntegrationPort } from "../integrations/store.js";
import { createProductMcpServer } from "./product-mcp.js";
import { invokeAssistantTool } from "../assistant/tools.js";

describe("product MCP wires an IntegrationPort into farm tools", () => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let prevDataDir: string | undefined;
  let prevHost: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.PRINT_PARTNER_DATA_DIR;
    prevHost = process.env.HOST;
    dataDir = mkdtempSync(join(tmpdir(), "pp-mcp-farm-"));
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    process.env.HOST = "127.0.0.1";

    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    saveFleet(repo, [
      {
        id: "trident",
        name: "Trident",
        model: "Trident",
        bed_width_mm: 300,
        bed_depth_mm: 300,
        bed_height_mm: 280,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: "int-trident",
      },
    ]);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = prevDataDir;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
  });

  function jobs(): InProcessJobRunner {
    return new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: sqlite.reposDir,
      exportsDir: join(dataDir, "exports"),
      dataDir,
    });
  }

  async function callFarmStatus(integrations?: IntegrationPort) {
    const server = createProductMcpServer({
      getRepo: () => repo,
      jobs: jobs(),
      config: loadConfig(),
      pending: new Map<string, AssistantProposedAction>(),
      integrations,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = (await client.callTool({
      name: "get_farm_status",
      arguments: {},
    })) as { content: Array<{ type: string; text: string }> };
    await client.close();
    return JSON.parse(result.content[0].text);
  }

  async function callPrintStats() {
    const server = createProductMcpServer({
      getRepo: () => repo,
      jobs: jobs(),
      config: loadConfig(),
      pending: new Map<string, AssistantProposedAction>(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "get_print_stats", arguments: {} });
    await client.close();
    if (!Array.isArray(result.content)) throw new Error("test MCP content is not an array");
    const content = result.content[0];
    if (
      !content ||
      typeof content !== "object" ||
      !("type" in content) ||
      content.type !== "text" ||
      !("text" in content) ||
      typeof content.text !== "string"
    ) {
      throw new Error("test MCP result is not text");
    }
    return JSON.parse(content.text);
  }

  it("reports live printer state from an injected IntegrationPort", async () => {
    const statuses: Record<string, PrinterHostStatus> = {
      "int-trident": { state: "printing", filename: "plate_ldo.gcode", progress: 42 },
    };
    const port = {
      getStatus: async (id: string) => {
        const s = statuses[id];
        if (!s) throw new Error("offline");
        return s;
      },
    } as unknown as IntegrationPort;

    const data = await callFarmStatus(port);

    // The regression: this was "unknown" before the port was wired in.
    expect(data.printers[0].state).toBe("printing");
    expect(data.printers[0].active_job).toBe("plate_ldo.gcode");
    expect(data.printing).toBe(1);
    expect(data.offline).toBe(0);
  });

  it("builds a real port when none is injected, instead of leaving it undefined", async () => {
    // No integration rows exist, so the real port cannot resolve "int-trident"
    // and the printer reads as offline. The point is that it goes through the
    // adapter path at all: without a port the tool short-circuits to "unknown"
    // and never attempts a host lookup.
    const data = await callFarmStatus();
    expect(data.printer_count).toBe(1);
    expect(data.printers[0].state).toBe("offline");
  });

  it("returns the same accepted Progress stats as the in-process assistant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    repo.createProfile("MCP Plan");
    try {
      const direct = JSON.parse(
        (await invokeAssistantTool("get_print_stats", {}, { repo })).content,
      );
      const mcp = await callPrintStats();
      expect(mcp).toEqual(direct);
      expect(mcp.active_plans).toEqual({
        kind: "available",
        plans: [
          expect.objectContaining({
            plan_name: "MCP Plan",
            accepted_progress: { kind: "empty" },
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches in-process collection failure without exposing private failure data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const sentinel = "private SQL /secret/path token_123";
    repo.listAcceptedProfileSummaries = () => {
      throw new Error(sentinel);
    };
    const log = vi.spyOn(getLogger(), "log").mockImplementation(() => undefined);
    try {
      const direct = JSON.parse(
        (await invokeAssistantTool("get_print_stats", {}, { repo })).content,
      );
      const mcp = await callPrintStats();
      expect(mcp).toEqual(direct);
      expect(mcp.active_plans).toEqual({ kind: "unavailable" });
      expect(JSON.stringify({ direct, mcp, logs: log.mock.calls })).not.toContain(sentinel);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
