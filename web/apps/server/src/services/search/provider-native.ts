/**
 * Helpers for anthropic-native / openai-native search messaging.
 *
 * The ASSISTANT_TOOL `web_search` still returns HTTP hits (via DuckDuckGo fallback)
 * so the tool loop always gets structured results. Status reports native when the
 * active AI provider supports it; the LLM may also use its own provider web tools.
 */

import type { AiProviderId } from "@print-partner/contracts";
import type { SearchProviderId } from "./types.js";

export function nativeSearchProviderForAi(
  aiProvider: AiProviderId,
): Extract<SearchProviderId, "anthropic-native" | "openai-native"> | null {
  if (aiProvider === "anthropic") return "anthropic-native";
  if (aiProvider === "openai") return "openai-native";
  return null;
}

export function nativeSearchNote(provider: SearchProviderId): string {
  if (provider === "anthropic-native") {
    return "Anthropic native web search is available with this AI provider; HTTP tool results use DuckDuckGo unless SEARCH_PROVIDER=brave|exa.";
  }
  if (provider === "openai-native") {
    return "OpenAI native web search is available with this AI provider; HTTP tool results use DuckDuckGo unless SEARCH_PROVIDER=brave|exa.";
  }
  return "";
}
