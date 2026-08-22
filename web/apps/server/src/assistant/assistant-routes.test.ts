import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import { registerAssistantRoutes } from "../routes/assistant.js";
import type { AssistantPort } from "./types.js";
import type { InProcessJobRunner } from "../routes/jobs.js";

vi.mock("./create-assistant.js", () => ({
  createAssistantPort: vi.fn(),
}));

import { createAssistantPort } from "./create-assistant.js";

const mockedCreate = vi.mocked(createAssistantPort);

function mockJobs(): InProcessJobRunner {
  return {
    start: vi.fn(async () => "job-test-1"),
  } as unknown as InProcessJobRunner;
}

describe("assistant routes", () => {
  let dataDir: string;
  let app: ReturnType<typeof Fastify>;
  let jobs: InProcessJobRunner;
  let repo: ReturnType<typeof createSelfHostPorts>["repository"];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-assistant-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
    jobs = mockJobs();

    const mockAssistant: AssistantPort = {
      provider: "anthropic",
      model: "test-model",
      configured: true,
      supportsTools: false,
      async complete() {
        return "Prefer the voron_2_4 catalog base and a stack preset.";
      },
      async stream(_params, handlers) {
        handlers.onToken("Hello ");
        handlers.onToken("kit.");
        handlers.onDone();
      },
    };
    mockedCreate.mockReturnValue(mockAssistant);

    const config = {
      ...loadConfig(),
      aiEnabled: true,
      aiProvider: "anthropic" as const,
      aiModel: "test-model",
      aiMaxTokens: 256,
      anthropicApiKey: "test-key-not-logged",
    };

    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (req: { tenantId: string }) => {
      req.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo: repo!, config, jobs });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("GET /assistant/status hides secrets and reports example flag", async () => {
    const res = await app.inject({ method: "GET", url: "/assistant/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enabled: boolean;
      provider: string;
      model: string | null;
      use_other_builds_as_examples: boolean;
      source?: string;
      search?: { provider: string; configured: boolean };
    };
    expect(body).toMatchObject({
      enabled: false,
      provider: "anthropic",
      model: "test-model",
      use_other_builds_as_examples: true,
      source: "env",
    });
    expect(body.search).toBeDefined();
    expect(typeof body.search?.configured).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(mockedCreate).toHaveBeenCalled();
  });

  it("status reports enabled=false while still resolving settings source for MCP tooling", async () => {
    await app.close();

    dataDir = mkdtempSync(join(tmpdir(), "pp-assistant-settings-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const { createIntegrationPort } = await import("../integrations/store.js");
    const { getIntegrationAdapter } = await import("../integrations/registry.js");
    createIntegrationPort({ repo, getAdapter: getIntegrationAdapter }).create({
      type: "ai_assistant",
      name: "Ollama",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
        use_other_builds_as_examples: false,
      },
    });

    mockedCreate.mockReturnValue({
      provider: "ollama",
      model: "llama3.2",
      configured: true,
      supportsTools: true,
      async complete() {
        return "ok";
      },
      async stream(_p, h) {
        h.onDone();
      },
    });

    const config = {
      ...loadConfig(),
      aiEnabled: false,
      aiProvider: "none" as const,
      aiModel: null,
      aiMaxTokens: 256,
      anthropicApiKey: null,
    };

    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("tenantId", "");
    app.addHook("onRequest", async (req: { tenantId: string }) => {
      req.tenantId = "default";
    });
    await registerAssistantRoutes(app, { repo, config, jobs: mockJobs() });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/assistant/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: false,
      provider: "ollama",
      model: "llama3.2",
      use_other_builds_as_examples: false,
      source: "settings",
    });
  });

  it("POST /assistant/chat returns 410 Gone (in-app advisor removed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/assistant/chat",
      payload: {
        stream: false,
        messages: [{ role: "user", content: "Which base should I use?" }],
      },
    });
    expect(res.statusCode).toBe(410);
    expect(JSON.stringify(res.json())).toMatch(/HTTP MCP|mcp/i);
  });

  it("stores feedback", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/assistant/feedback",
      payload: { rating: "up", message_excerpt: "helpful tip", comment: "clear steps" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const listed = await app.inject({ method: "GET", url: "/assistant/feedback" });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { entries: Array<{ rating: string; message_excerpt: string }> };
    expect(body.entries.some((e) => e.rating === "up" && e.message_excerpt?.includes("helpful"))).toBe(
      true,
    );
  });

  it("GET /assistant/preferences returns digest in self-host", async () => {
    const res = await app.inject({ method: "GET", url: "/assistant/preferences" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { digest: string | null; thumbs_prefer: string | null };
    expect(body).toHaveProperty("digest");
    expect(body).toHaveProperty("thumbs_prefer");
  });

  it("DELETE /assistant/decisions requires plan_id or all=true", async () => {
    const bad = await app.inject({ method: "DELETE", url: "/assistant/decisions" });
    expect(bad.statusCode).toBe(400);

    const plan = repo!.createProfile("Memory plan");
    repo!.createPlanDecision({
      planId: plan.id,
      actor: "user",
      kind: "applied_action",
      actionType: "add_addon",
      params: { source_name: "Voron-Stealthburner" },
      label: "Add Stealthburner",
      summary: "applied",
    });

    const cleared = await app.inject({
      method: "DELETE",
      url: `/assistant/decisions?plan_id=${plan.id}`,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ ok: true, scope: "plan", deleted: 1 });
    expect(repo!.listPlanDecisions(plan.id)).toHaveLength(0);
  });

  it("DELETE /assistant/feedback clears thumbs ratings", async () => {
    await app.inject({
      method: "POST",
      url: "/assistant/feedback",
      payload: { rating: "up", message_excerpt: "great" },
    });
    const cleared = await app.inject({ method: "DELETE", url: "/assistant/feedback" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ ok: true, deleted: 1 });
    const listed = await app.inject({ method: "GET", url: "/assistant/feedback" });
    expect((listed.json() as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("DELETE /assistant/history clears stored turns", async () => {
    const cleared = await app.inject({ method: "DELETE", url: "/assistant/history" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ ok: true });
    const hist = await app.inject({ method: "GET", url: "/assistant/history" });
    expect((hist.json() as { messages: unknown[] }).messages).toHaveLength(0);
  });
});
