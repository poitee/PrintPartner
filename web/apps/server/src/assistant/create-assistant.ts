import type { AssistantRuntimeConfig } from "./resolve-assistant.js";
import { createAnthropicAssistant } from "./anthropic-adapter.js";
import { createNoneAssistant } from "./none-adapter.js";
import { createOpenAiCompatibleAssistant } from "./openai-adapter.js";
import type { AssistantPort } from "./types.js";

export function createAssistantPort(runtime: AssistantRuntimeConfig): AssistantPort {
  if (!runtime.enabled) return createNoneAssistant();

  if (runtime.provider === "anthropic" && runtime.anthropicApiKey) {
    return createAnthropicAssistant({
      apiKey: runtime.anthropicApiKey,
      defaultModel: runtime.aiModel ?? "claude-sonnet-4-20250514",
    });
  }

  if (runtime.provider === "openai" && runtime.openaiApiKey) {
    return createOpenAiCompatibleAssistant({
      provider: "openai",
      apiKey: runtime.openaiApiKey,
      baseUrl: runtime.openaiBaseUrl ?? "https://api.openai.com",
      defaultModel: runtime.aiModel ?? "gpt-4o-mini",
    });
  }

  if (runtime.provider === "ollama") {
    return createOpenAiCompatibleAssistant({
      provider: "ollama",
      apiKey: null,
      baseUrl: runtime.ollamaUrl,
      defaultModel: runtime.aiModel ?? "llama3.1",
      numCtx: runtime.ollamaNumCtx,
    });
  }

  return createNoneAssistant();
}

export type { AssistantPort } from "./types.js";
export type { AssistantRuntimeConfig } from "./resolve-assistant.js";
