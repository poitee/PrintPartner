import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicAssistant } from "./anthropic-adapter.js";
import { createOpenAiCompatibleAssistant } from "./openai-adapter.js";
import type { AssistantChatParams } from "./types.js";

const params: AssistantChatParams = {
  system: "Be concise.",
  messages: [{ role: "user", content: "Hello" }],
  model: "local-model",
  maxTokens: 32,
};

function handlers(tokens: string[]) {
  return {
    onToken: (token: string) => tokens.push(token),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

describe("assistant remote streams", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits an Ollama NDJSON token when the final event has no newline", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: { content: "last token" } }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const assistant = createOpenAiCompatibleAssistant({
      provider: "ollama",
      apiKey: null,
      baseUrl: "http://127.0.0.1:11434",
      defaultModel: "local-model",
    });
    const tokens: string[] = [];
    const callbacks = handlers(tokens);
    const controller = new AbortController();

    await assistant.stream({ ...params, signal: controller.signal }, callbacks);

    expect(tokens).toEqual(["last token"]);
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    const providerSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(providerSignal?.aborted).toBe(true);
  });

  it("emits an Anthropic SSE token when the final event has no newline", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "last token" },
      })}`,
    ));
    vi.stubGlobal("fetch", fetchMock);
    const assistant = createAnthropicAssistant({
      apiKey: "test-key",
      defaultModel: "claude-test",
    });
    const tokens: string[] = [];
    const callbacks = handlers(tokens);

    await assistant.stream(params, callbacks);

    expect(tokens).toEqual(["last token"]);
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
