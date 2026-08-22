import type { AssistantPort } from "./types.js";

export function createNoneAssistant(): AssistantPort {
  return {
    provider: "none",
    model: null,
    configured: false,
    supportsTools: false,
    async complete() {
      throw new Error("AI assistant is not configured");
    },
    async stream(_params, handlers) {
      handlers.onError(new Error("AI assistant is not configured"));
    },
  };
}
