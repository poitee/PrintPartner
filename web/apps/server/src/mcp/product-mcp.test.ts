/**
 * confirm_apply: reserve before await, reject concurrent confirm, restore on failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { loadConfig } from "../config.js";
import * as tools from "../assistant/tools.js";
import { createProductMcpServer } from "./product-mcp.js";

describe("product MCP confirm_apply reservation", () => {
  let prevKey: string | undefined;
  let prevDataDir: string | undefined;
  let prevHost: string | undefined;

  beforeEach(() => {
    prevKey = process.env.PRINT_PARTNER_API_KEY;
    prevDataDir = process.env.PRINT_PARTNER_DATA_DIR;
    prevHost = process.env.HOST;
    process.env.PRINT_PARTNER_API_KEY = "test-key";
    process.env.PRINT_PARTNER_DATA_DIR = "/tmp/pp-mcp-confirm-test";
    process.env.HOST = "127.0.0.1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevKey === undefined) delete process.env.PRINT_PARTNER_API_KEY;
    else process.env.PRINT_PARTNER_API_KEY = prevKey;
    if (prevDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = prevDataDir;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
  });

  async function withClient(pending: Map<string, AssistantProposedAction>) {
    const config = loadConfig();
    const server = createProductMcpServer({
      getRepo: () => ({ getProfile: () => null }) as never,
      jobs: { start: async () => "j1" } as never,
      config,
      pending,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  it("rejects concurrent confirm of the same action_id and restores on apply failure", async () => {
    const action: AssistantProposedAction = {
      id: "act-1",
      type: "set_base",
      plan_id: 1,
      label: "Set base",
      summary: "test",
      params: { source_name: "Other" },
    };
    const pending = new Map<string, AssistantProposedAction>([["act-1", action]]);

    let release!: (v: { ok: boolean; detail?: string }) => void;
    const gate = new Promise<{ ok: boolean; detail?: string }>((r) => {
      release = r;
    });
    vi.spyOn(tools, "applyAssistantAction").mockImplementation(() => gate);

    const { client, server } = await withClient(pending);

    const first = client.callTool({
      name: "confirm_apply",
      arguments: { action_id: "act-1" },
    });
    // Allow the first handler to reserve + hit the await.
    await Promise.resolve();
    await Promise.resolve();

    expect(pending.has("act-1")).toBe(false);

    const second = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: "act-1" },
    });
    expect(second.isError).toBe(true);
    const secondText = String(
      (second.content as { type: string; text?: string }[])[0]?.text ?? "",
    );
    expect(secondText).toMatch(/in-flight|already applied/i);

    release({ ok: false, detail: "Plan not found" });
    const firstResult = await first;
    expect(firstResult.isError).toBe(true);
    expect(pending.get("act-1")).toEqual(action);

    await client.close();
    await server.close();
  });

  it("leaves action removed after successful apply (one mutation)", async () => {
    const action: AssistantProposedAction = {
      id: "act-2",
      type: "set_base",
      plan_id: 1,
      label: "Set base",
      summary: "test",
      params: { source_name: "Other" },
    };
    const pending = new Map<string, AssistantProposedAction>([["act-2", action]]);
    vi.spyOn(tools, "applyAssistantAction").mockResolvedValue({ ok: true, detail: "done" });

    const { client, server } = await withClient(pending);
    const result = await client.callTool({
      name: "confirm_apply",
      arguments: { action_id: "act-2" },
    });
    expect(result.isError).toBeFalsy();
    expect(pending.has("act-2")).toBe(false);
    expect(tools.applyAssistantAction).toHaveBeenCalledTimes(1);

    await client.close();
    await server.close();
  });
});
