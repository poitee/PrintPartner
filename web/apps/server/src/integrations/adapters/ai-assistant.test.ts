import { afterEach, describe, expect, it, vi } from "vitest";
import { aiAssistantAdapter } from "./ai-assistant.js";

describe("aiAssistantAdapter.testConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pings Ollama /api/tags and requires an installed model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.1:latest" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await aiAssistantAdapter.testConnection({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
      model: "llama3.1",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Ollama");
    expect(result.message).toContain("llama3.1");
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://127.0.0.1:11434/api/tags");
  });

  it("fails Ollama test when model is missing", async () => {
    const result = await aiAssistantAdapter.testConnection({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/model is required/i);
  });

  it("fails Ollama test when configured model is not installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.1:latest" }] }),
      }),
    );

    const result = await aiAssistantAdapter.testConnection({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
      model: "llama3.2",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/llama3\.2/);
    expect(result.message).toMatch(/llama3\.1:latest/);
  });

  it("repairs http:/host URLs when testing Ollama", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.1:latest" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await aiAssistantAdapter.testConnection({
      provider: "ollama",
      base_url: "http:/127.0.0.1:11434",
      model: "llama3.1:latest",
    });
    expect(result.ok).toBe(true);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://127.0.0.1:11434/api/tags");
  });

  it("requires api_key for openai", async () => {
    const result = await aiAssistantAdapter.testConnection({
      provider: "openai",
      base_url: "https://api.openai.com",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/api_key/i);
  });

  it("rejects missing provider", async () => {
    const result = await aiAssistantAdapter.testConnection({ model: "x" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/provider/i);
  });

  it("accepts extended Settings config keys without breaking connection test", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.1:latest" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await aiAssistantAdapter.testConnection({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
      model: "llama3.1",
      max_tokens: 4096,
      search_provider: "brave",
      search_api_key: "secret-search",
      allow_url_ingest: true,
      guide_ingest_max_bytes: 1024,
      ollama_num_ctx: 8192,
      daily_request_budget: 10,
      daily_token_budget: 100000,
      use_other_builds_as_examples: false,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});
