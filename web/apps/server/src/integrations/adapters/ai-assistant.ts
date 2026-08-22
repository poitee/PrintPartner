import type { AiProviderId, IntegrationConfig, IntegrationTestResult } from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";
import { assertSafeOutboundUrl } from "../../lib/outbound-url.js";

/**
 * Connection-test adapter for `ai_assistant` integrations.
 *
 * Documented config keys (resolved by `resolveAssistantRuntime`, not this adapter):
 * provider, model, api_key, base_url / ollama_url, max_tokens,
 * use_other_builds_as_examples, daily_*_budget, enabled,
 * search_provider, search_api_key, allow_url_ingest, guide_ingest_max_bytes,
 * ollama_num_ctx.
 *
 * `testConnection` only needs provider credentials + reachability.
 */

function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  // Repair accidental `http:/host` (one slash) → `http://host`
  return raw
    .trim()
    .replace(/^(https?):\/(?!\/)/i, "$1://")
    .replace(/\/+$/, "");
}

function parseProvider(raw: unknown): AiProviderId {
  if (raw === "anthropic" || raw === "openai" || raw === "ollama") return raw;
  return "none";
}

function configApiKey(config: IntegrationConfig): string | null {
  const key = config.api_key ?? config.apiKey;
  if (typeof key !== "string" || !key.trim()) return null;
  return key.trim();
}

function configBaseUrl(config: IntegrationConfig): string | null {
  return normalizeBaseUrl(
    config.base_url ?? config.ollama_url ?? config.baseUrl ?? config.ollamaUrl,
  );
}

function configModel(config: IntegrationConfig): string | null {
  const model = config.model;
  if (typeof model !== "string" || !model.trim()) return null;
  return model.trim();
}

/** True if `wanted` matches an installed Ollama model name (exact or tag-prefix). */
export function ollamaModelInstalled(
  models: Array<{ name?: unknown; model?: unknown }>,
  wanted: string,
): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return false;
  for (const entry of models) {
    for (const raw of [entry.name, entry.model]) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const n = raw.trim().toLowerCase();
      if (n === w || n.startsWith(`${w}:`) || w.startsWith(`${n}:`)) return true;
    }
  }
  return false;
}

function listModelNames(models: Array<{ name?: unknown; model?: unknown }>): string[] {
  const names: string[] = [];
  for (const entry of models) {
    const label =
      (typeof entry.name === "string" && entry.name.trim()) ||
      (typeof entry.model === "string" && entry.model.trim()) ||
      null;
    if (label && !names.includes(label)) names.push(label);
  }
  return names;
}

async function safeGet(
  url: string,
  init: RequestInit,
  allowPrivate: boolean,
): Promise<Response> {
  await assertSafeOutboundUrl(url, { allowPrivate });
  return fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
}

export const aiAssistantAdapter: IntegrationAdapter = {
  type: "ai_assistant",

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const provider = parseProvider(config.provider);
    if (provider === "none") {
      return { ok: false, message: "provider must be anthropic, openai, or ollama" };
    }

    try {
      if (provider === "ollama") {
        // allowPrivate: LAN / 127.0.0.1 (native) / host.docker.internal (Compose → host Ollama)
        const baseUrl = configBaseUrl(config) ?? "http://127.0.0.1:11434";
        const model = configModel(config);
        if (!model) {
          return {
            ok: false,
            message:
              "Model is required for Ollama. Set Model to an exact name from `ollama list` (e.g. llama3.1:latest).",
          };
        }
        const res = await safeGet(`${baseUrl}/api/tags`, {}, true);
        if (!res.ok) {
          return { ok: false, message: `Ollama returned HTTP ${res.status}` };
        }
        const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
        const models = Array.isArray(body.models) ? body.models : [];
        const count = models.length;
        if (!ollamaModelInstalled(models, model)) {
          const installed = listModelNames(models);
          const hint =
            installed.length > 0
              ? ` Installed: ${installed.slice(0, 8).join(", ")}${installed.length > 8 ? "…" : ""}.`
              : " No models installed — run `ollama pull <name>` on the host.";
          return {
            ok: false,
            message: `Connected to Ollama, but model "${model}" was not found.${hint}`,
          };
        }
        return {
          ok: true,
          message: `Connected to Ollama (model ${model}; ${count} installed)`,
        };
      }

      if (provider === "openai") {
        const apiKey = configApiKey(config);
        if (!apiKey) return { ok: false, message: "api_key is required for OpenAI" };
        const baseUrl = configBaseUrl(config) ?? "https://api.openai.com";
        const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
        const res = await safeGet(`${baseUrl}/v1/models`, { headers }, true);
        if (!res.ok) {
          return { ok: false, message: `OpenAI-compatible API returned HTTP ${res.status}` };
        }
        return { ok: true, message: "Connected (OpenAI-compatible)" };
      }

      // anthropic
      const apiKey = configApiKey(config);
      if (!apiKey) return { ok: false, message: "api_key is required for Anthropic" };
      const res = await safeGet(
        "https://api.anthropic.com/v1/models",
        {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        false,
      );
      if (!res.ok) {
        return { ok: false, message: `Anthropic returned HTTP ${res.status}` };
      }
      return { ok: true, message: "Connected (Anthropic)" };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
