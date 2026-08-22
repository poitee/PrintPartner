import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import { createIntegrationPort } from "../integrations/store.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import {
  parseSearchProviderOverride,
  resolveAssistantRuntime,
} from "./resolve-assistant.js";

describe("parseSearchProviderOverride", () => {
  it("maps the removed SearXNG setting to its former DuckDuckGo fallback", () => {
    expect(parseSearchProviderOverride("searxng")).toBe("duckduckgo");
  });
});

describe("resolveAssistantRuntime", () => {
  let dataDir: string;
  let repo: ReturnType<typeof createSelfHostPorts>["repository"];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-ai-resolve-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("falls back to env when no settings integration exists", () => {
    const env = {
      ...loadConfig(),
      aiEnabled: true,
      aiProvider: "anthropic" as const,
      anthropicApiKey: "sk-env",
      aiModel: "env-model",
      aiMaxTokens: 512,
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.source).toBe("env");
    expect(runtime.enabled).toBe(true);
    expect(runtime.provider).toBe("anthropic");
    expect(runtime.anthropicApiKey).toBe("sk-env");
    expect(runtime.aiModel).toBe("env-model");
  });

  it("prefers an enabled ai_assistant settings integration over env", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local Ollama",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
      },
    });

    const env = {
      ...loadConfig(),
      aiEnabled: true,
      aiProvider: "anthropic" as const,
      anthropicApiKey: "sk-env-should-not-win",
      aiModel: "env-model",
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.source).toBe("settings");
    expect(runtime.enabled).toBe(true);
    expect(runtime.provider).toBe("ollama");
    expect(runtime.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(runtime.aiModel).toBe("llama3.2");
    expect(runtime.anthropicApiKey).toBeNull();
    expect(runtime.useOtherBuildsAsExamples).toBe(true);
  });

  it("normalizes a persisted SearXNG setting to the former DuckDuckGo fallback", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Legacy search settings",
      config: {
        provider: "ollama",
        enabled: true,
        search_provider: "searxng",
      },
    });

    const runtime = resolveAssistantRuntime(repo, {
      ...loadConfig(),
      searchProvider: "exa",
    });

    expect(runtime.searchProvider).toBe("duckduckgo");
  });

  it("honors use_other_builds_as_examples=false from settings", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
        use_other_builds_as_examples: false,
      },
    });
    const runtime = resolveAssistantRuntime(repo, loadConfig());
    expect(runtime.useOtherBuildsAsExamples).toBe(false);
  });

  it("honors daily budgets from settings over env", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
        daily_request_budget: 12,
        daily_token_budget: 50000,
      },
    });
    const env = {
      ...loadConfig(),
      aiDailyRequestBudget: 99,
      aiDailyTokenBudget: 1,
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.aiDailyRequestBudget).toBe(12);
    expect(runtime.aiDailyTokenBudget).toBe(50000);
  });

  it("skips disabled settings and uses env", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Off",
      config: {
        provider: "ollama",
        model: "llama3.2",
        enabled: false,
      },
    });

    const env = {
      ...loadConfig(),
      aiEnabled: false,
      aiProvider: "none" as const,
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.enabled).toBe(false);
    expect(runtime.source).toBe("none");
  });

  it("enables via settings alone without AI_ENABLED", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Cloud",
      config: {
        provider: "openai",
        api_key: "sk-settings",
        base_url: "https://api.openai.com",
        model: "gpt-4o-mini",
        enabled: true,
      },
    });

    const env = {
      ...loadConfig(),
      aiEnabled: false,
      aiProvider: "none" as const,
      openaiApiKey: null,
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.source).toBe("settings");
    expect(runtime.enabled).toBe(true);
    expect(runtime.provider).toBe("openai");
    expect(runtime.openaiApiKey).toBe("sk-settings");
  });

  it("honors max_tokens from settings over env", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
        max_tokens: 4096,
      },
    });
    const env = { ...loadConfig(), aiMaxTokens: 512 };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.aiMaxTokens).toBe(4096);
  });

  it("resolves search, URL ingest, and ollama_num_ctx from settings over env", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
        search_provider: "brave",
        search_api_key: "brave-settings-key",
        allow_url_ingest: false,
        guide_ingest_max_bytes: 1024,
        ollama_num_ctx: 8192,
      },
    });
    const env = {
      ...loadConfig(),
      searchProvider: "exa" as const,
      searchApiKey: "env-key-should-not-win",
      assistantAllowUrlIngest: true,
      assistantGuideIngestMaxBytes: 524288,
    };
    const runtime = resolveAssistantRuntime(repo, env);
    expect(runtime.searchProvider).toBe("brave");
    expect(runtime.searchApiKey).toBe("brave-settings-key");
    expect(runtime.assistantAllowUrlIngest).toBe(false);
    expect(runtime.assistantGuideIngestMaxBytes).toBe(1024);
    expect(runtime.ollamaNumCtx).toBe(8192);
  });

  it("leaves search overrides null when Settings omits them (env used at search layer)", () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
    });
    integrations.create({
      type: "ai_assistant",
      name: "Local",
      config: {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "llama3.2",
        enabled: true,
      },
    });
    const runtime = resolveAssistantRuntime(repo, loadConfig());
    expect(runtime.searchProvider).toBeNull();
    expect(runtime.searchApiKey).toBeNull();
    expect(runtime.assistantAllowUrlIngest).toBe(loadConfig().assistantAllowUrlIngest);
  });
});
