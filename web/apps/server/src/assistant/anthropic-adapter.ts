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

type AnthropicDeps = {
  apiKey: string;
  defaultModel: string;
};

function toAnthropicMessages(
  messages: AssistantChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      out.push({ role, content: m.content });
    }
  }
  if (out.length === 0 || out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "(continue)" });
  }
  return out;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    };

function toAnthropicToolMessages(
  messages: AssistantToolMessage[],
): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> = [];

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      const last = out[out.length - 1];
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    // assistant
    if ("toolCalls" in m && m.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input ?? {},
        });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }

  if (out.length === 0 || out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "(continue)" });
  }
  return out;
}

function parseToolCalls(content: Array<Record<string, unknown>>): {
  text: string;
  toolCalls: AssistantToolCallRequest[];
} {
  const textParts: string[] = [];
  const toolCalls: AssistantToolCallRequest[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input:
          block.input && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return { text: textParts.join(""), toolCalls };
}

export function createAnthropicAssistant(deps: AnthropicDeps): AssistantPort {
  const model = deps.defaultModel;

  async function request(params: AssistantChatParams, stream: boolean): Promise<Response> {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: params.model || model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: toAnthropicMessages(params.messages),
        stream,
      }),
    });
  }

  return {
    provider: "anthropic",
    model,
    configured: true,
    supportsTools: true,

    async complete(params) {
      const res = await request(params, false);
      if (!res.ok) throw new Error(await readProviderHttpError("Anthropic", res));
      const body = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (body.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("");
      if (!text) throw new Error("Anthropic returned an empty response");
      return text;
    },

    async completeWithTools(params: AssistantToolsParams): Promise<AssistantCompletionResult> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": deps.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: params.model || model,
          max_tokens: params.maxTokens,
          system: params.system,
          messages: toAnthropicToolMessages(params.messages),
          tools: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        }),
      });
      if (!res.ok) throw new Error(await readProviderHttpError("Anthropic", res));
      const body = (await res.json()) as {
        content?: Array<Record<string, unknown>>;
        stop_reason?: string;
      };
      const parsed = parseToolCalls(body.content ?? []);
      const stopReason =
        body.stop_reason === "tool_use" || parsed.toolCalls.length > 0 ? "tool_use" : "end_turn";
      return {
        content: parsed.text,
        toolCalls: parsed.toolCalls,
        stopReason,
      };
    },

    async stream(params, handlers: AssistantStreamHandlers) {
      try {
        const res = await request(params, true);
        if (!res.ok) {
          handlers.onError(new Error(await readProviderHttpError("Anthropic", res)));
          return;
        }
        if (!res.body) {
          handlers.onError(new Error("Anthropic stream body missing"));
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
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as {
                type?: string;
                delta?: { type?: string; text?: string };
              };
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "text_delta" &&
                event.delta.text
              ) {
                handlers.onToken(event.delta.text);
              }
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
