import type { AssistantChatMessage } from "@print-partner/contracts";
import { readProviderHttpError } from "./provider-error.js";
import type {
  AssistantChatParams,
  AssistantCompletionResult,
  AssistantPort,
  AssistantStreamHandlers,
  AssistantToolCallRequest,
  AssistantToolMessage,
  AssistantToolsParams,
} from "./types.js";

type OpenAiDeps = {
  provider: "openai" | "ollama";
  apiKey: string | null;
  baseUrl: string;
  defaultModel: string;
  /** Ollama native chat context window (`num_ctx`). Defaults from env / 16384. */
  numCtx?: number;
};

function toOpenAiMessages(
  system: string,
  messages: AssistantChatMessage[],
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
  ];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return out;
}

type OpenAiMsg =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAiToolMessages(system: string, messages: AssistantToolMessage[]): OpenAiMsg[] {
  const out: OpenAiMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }
    if ("toolCalls" in m && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          },
        })),
      });
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorLabel(provider: "openai" | "ollama"): string {
  return provider === "ollama" ? "Ollama" : "OpenAI-compatible";
}

/**
 * Default context window for Ollama native chat when deps.numCtx is omitted.
 * Ollama's OpenAI-compatible endpoint ignores options.num_ctx and defaults to ~4k,
 * silently truncating the start of long prompts (which drops our system prompt).
 * The native /api/chat endpoint honors num_ctx.
 */
function defaultOllamaNumCtx(): number {
  const raw = Number(process.env.OLLAMA_NUM_CTX ?? "");
  return Number.isFinite(raw) && raw >= 2048 ? Math.floor(raw) : 16384;
}

type OllamaMsg =
  | { role: "system" | "user" | "assistant" | "tool"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
    };

function toOllamaMessages(system: string, messages: AssistantChatMessage[]): OllamaMsg[] {
  const out: OllamaMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    out.push({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content,
    });
  }
  return out;
}

function toOllamaToolMessages(system: string, messages: AssistantToolMessage[]): OllamaMsg[] {
  const out: OllamaMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content });
      continue;
    }
    if ("toolCalls" in m && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> },
        })),
      });
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

export function createOpenAiCompatibleAssistant(deps: OpenAiDeps): AssistantPort {
  const model = deps.defaultModel;
  const isOllama = deps.provider === "ollama";
  const baseUrl = deps.baseUrl.replace(/\/$/, "");
  const completionsUrl = `${baseUrl}/v1/chat/completions`;
  const ollamaChatUrl = `${baseUrl}/api/chat`;
  const label = errorLabel(deps.provider);
  const ollamaNumCtx =
    typeof deps.numCtx === "number" && Number.isFinite(deps.numCtx) && deps.numCtx >= 2048
      ? Math.floor(deps.numCtx)
      : defaultOllamaNumCtx();
  // Ollama tool support varies by model; attempt tools for OpenAI always, Ollama best-effort.
  const supportsTools = true;

  function resolveModel(requested?: string | null): string {
    const effectiveModel = (requested || model).trim();
    if (!effectiveModel) {
      throw new Error(
        "AI model is not configured. Set Model under Settings → AI assistant (must match `ollama list` for Ollama).",
      );
    }
    return effectiveModel;
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (deps.apiKey) headers.authorization = `Bearer ${deps.apiKey}`;
    return headers;
  }

  async function request(params: AssistantChatParams, stream: boolean): Promise<Response> {
    const effectiveModel = resolveModel(params.model);
    if (isOllama) {
      return fetch(ollamaChatUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          model: effectiveModel,
          messages: toOllamaMessages(params.system, params.messages),
          stream,
          options: { num_ctx: ollamaNumCtx, num_predict: params.maxTokens },
        }),
      });
    }
    return fetch(completionsUrl, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        model: effectiveModel,
        max_tokens: params.maxTokens,
        messages: toOpenAiMessages(params.system, params.messages),
        stream,
      }),
    });
  }

  return {
    provider: deps.provider,
    model,
    configured: true,
    supportsTools,

    async complete(params) {
      const res = await request(params, false);
      if (!res.ok) throw new Error(await readProviderHttpError(label, res));
      if (isOllama) {
        const body = (await res.json()) as { message?: { content?: string } };
        const text = body.message?.content?.trim() ?? "";
        if (!text) throw new Error("Model returned an empty response");
        return text;
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("Model returned an empty response");
      return text;
    },

    async completeWithTools(params: AssistantToolsParams): Promise<AssistantCompletionResult> {
      const effectiveModel = resolveModel(params.model);
      const headers = buildHeaders();

      if (isOllama) {
        const res = await fetch(ollamaChatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: effectiveModel,
            messages: toOllamaToolMessages(params.system, params.messages),
            stream: false,
            tools: params.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            })),
            options: { num_ctx: ollamaNumCtx, num_predict: params.maxTokens },
          }),
        });
        if (!res.ok) {
          const detail = await readProviderHttpError(label, res);
          const err = new Error(detail);
          // Model may not support tools at all — signal degrade to caller.
          (err as Error & { toolsUnsupported?: boolean }).toolsUnsupported = true;
          throw err;
        }
        const body = (await res.json()) as {
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              function?: { name?: string; arguments?: Record<string, unknown> | string };
            }>;
          };
        };
        const msg = body.message;
        const toolCalls: AssistantToolCallRequest[] = (msg?.tool_calls ?? [])
          .filter((c) => c.function?.name)
          .map((c, i) => ({
            id: `call_${i}`,
            name: c.function!.name!,
            input:
              typeof c.function!.arguments === "string"
                ? parseArgs(c.function!.arguments)
                : ((c.function!.arguments ?? {}) as Record<string, unknown>),
          }));
        const content = (msg?.content ?? "").trim();
        return {
          content,
          toolCalls,
          stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        };
      }

      const res = await fetch(completionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: params.maxTokens,
          messages: toOpenAiToolMessages(params.system, params.messages),
          tools: params.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          })),
          tool_choice: "auto",
        }),
      });

      // Older models may reject tools — signal degrade to caller.
      if (!res.ok) {
        const detail = await readProviderHttpError(label, res);
        if (/tool/i.test(detail) || res.status === 400 || res.status === 404) {
          const err = new Error(detail);
          (err as Error & { toolsUnsupported?: boolean }).toolsUnsupported = true;
          throw err;
        }
        throw new Error(detail);
      }

      const body = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const choice = body.choices?.[0];
      const msg = choice?.message;
      const toolCalls: AssistantToolCallRequest[] = (msg?.tool_calls ?? [])
        .filter((c) => c.function?.name)
        .map((c, i) => ({
          id: c.id || `call_${i}`,
          name: c.function!.name!,
          input: parseArgs(c.function!.arguments ?? "{}"),
        }));
      const content = (msg?.content ?? "").trim();
      const stopReason =
        toolCalls.length > 0 || choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      return { content, toolCalls, stopReason };
    },

    async stream(params, handlers: AssistantStreamHandlers) {
      try {
        const res = await request(params, true);
        if (!res.ok) {
          handlers.onError(new Error(await readProviderHttpError(label, res)));
          return;
        }
        if (!res.body) {
          handlers.onError(new Error("Stream body missing"));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (isOllama) {
              // Native /api/chat streams NDJSON objects.
              try {
                const event = JSON.parse(trimmed) as { message?: { content?: string } };
                const token = event.message?.content;
                if (token) handlers.onToken(token);
              } catch {
                /* skip malformed NDJSON chunk */
              }
              continue;
            }
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const token = event.choices?.[0]?.delta?.content;
              if (token) handlers.onToken(token);
            } catch {
              /* skip malformed SSE chunk */
            }
          }
        }
        handlers.onDone();
      } catch (e) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}
