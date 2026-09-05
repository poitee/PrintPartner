import type { AssistantChatMessage } from "@print-partner/contracts";
import {
  isJsonObject as isRecord,
  readBoundedJsonResponse,
  readBoundedResponseChunks,
} from "../lib/bounded-response.js";
import { readProviderHttpError } from "./provider-error.js";
import { fetchAssistantProvider } from "./provider-fetch.js";
import type {
  AssistantChatParams,
  AssistantCompletionResult,
  AssistantPort,
  AssistantStreamHandlers,
  AssistantToolCallRequest,
  AssistantToolMessage,
  AssistantToolsParams,
} from "./types.js";

const MAX_COMPLETION_RESPONSE_BYTES = 32 * 1024 * 1024;

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

function parseToolCalls(content: unknown): {
  text: string;
  toolCalls: AssistantToolCallRequest[];
} {
  const textParts: string[] = [];
  const toolCalls: AssistantToolCallRequest[] = [];
  if (!Array.isArray(content)) return { text: "", toolCalls: [] };
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: isRecord(block.input) ? block.input : {},
      });
    }
  }
  return { text: textParts.join(""), toolCalls };
}

export function createAnthropicAssistant(deps: AnthropicDeps): AssistantPort {
  const model = deps.defaultModel;

  async function request(params: AssistantChatParams, stream: boolean): Promise<Response> {
    return fetchAssistantProvider("https://api.anthropic.com/v1/messages", {
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
      signal: params.signal,
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
      const body = await readBoundedJsonResponse(res, MAX_COMPLETION_RESPONSE_BYTES);
      const content = isRecord(body) && Array.isArray(body.content) ? body.content : [];
      const text = content
        .flatMap((block) => isRecord(block) && block.type === "text"
          && typeof block.text === "string" && block.text
          ? [block.text]
          : [])
        .join("");
      if (!text) throw new Error("Anthropic returned an empty response");
      return text;
    },

    async completeWithTools(params: AssistantToolsParams): Promise<AssistantCompletionResult> {
      const res = await fetchAssistantProvider("https://api.anthropic.com/v1/messages", {
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
        signal: params.signal,
      });
      if (!res.ok) throw new Error(await readProviderHttpError("Anthropic", res));
      const body = await readBoundedJsonResponse(res, MAX_COMPLETION_RESPONSE_BYTES);
      const content = isRecord(body) ? body.content : undefined;
      const parsed = parseToolCalls(content);
      const stopReason =
        (isRecord(body) && body.stop_reason === "tool_use") || parsed.toolCalls.length > 0
          ? "tool_use"
          : "end_turn";
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
        const decoder = new TextDecoder();
        let buffer = "";
        const processLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") return;
          try {
            const event: unknown = JSON.parse(payload);
            const delta = isRecord(event) && isRecord(event.delta) ? event.delta : null;
            if (
              isRecord(event) &&
              event.type === "content_block_delta" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string" &&
              delta.text
            ) {
              handlers.onToken(delta.text);
            }
          } catch {
            /* skip malformed SSE chunk */
          }
        };
        for await (const value of readBoundedResponseChunks(
          res,
          MAX_COMPLETION_RESPONSE_BYTES,
        )) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            processLine(line);
          }
        }
        buffer += decoder.decode();
        processLine(buffer);
        handlers.onDone();
      } catch (e) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}
