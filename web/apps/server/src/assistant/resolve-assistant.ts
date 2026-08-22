import type { AiProviderId, SearchProviderId } from "@print-partner/contracts";
import type { ServerConfig } from "../config.js";
import type { AppRepository } from "../db/repository.js";
import { listIntegrationsByType } from "../integrations/store.js";
import { isSearchProviderId } from "../services/search/types.js";

/** Runtime AI settings after resolving Settings integration vs env defaults. */
export type AssistantRuntimeConfig = {
  enabled: boolean;
  provider: AiProviderId;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  openaiBaseUrl: string | null;
  ollamaUrl: string;
  aiModel: string | null;
  aiMaxTokens: number;
  /**
   * Include other accessible plans as few-shot *examples* in context.
   * This is NOT model training / fine-tuning.
   */
  useOtherBuildsAsExamples: boolean;
  /** Soft daily chat request cap per tenant (`0` = unlimited). */
  aiDailyRequestBudget: number;
  /** Soft daily estimated-token cap per tenant (`0` = unlimited). */
  aiDailyTokenBudget: number;
  /**
   * Settings override for web search provider.
   * `null` = no override (use env `SEARCH_PROVIDER` / auto resolution).
   */
  searchProvider: SearchProviderId | null;
  /**
   * Settings override for Brave/Exa API key.
   * `null` = no override (use env `SEARCH_API_KEY` / Brave/Exa aliases).
   */
  searchApiKey: string | null;
  /** Whether URL research tools may fetch user-supplied URLs. */
  assistantAllowUrlIngest: boolean;
  /** Max response body size for a single guide / page URL fetch. */
  assistantGuideIngestMaxBytes: number;
  /** Ollama native chat `num_ctx` (context window). */
  ollamaNumCtx: number;
  /** Where the active provider settings came from. */
  source: "settings" | "env" | "none";
};

function parseProvider(raw: unknown): AiProviderId {
  if (raw === "anthropic" || raw === "openai" || raw === "ollama" || raw === "none") {
    return raw;
  }
  return "none";
}

function defaultModel(provider: AiProviderId, explicit: string | null): string | null {
  if (explicit) return explicit;
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "ollama") return "llama3.1";
  return null;
}

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  // Repair accidental `http:/host` (one slash) → `http://host`
  return raw
    .trim()
    .replace(/^(https?):\/(?!\/)/i, "$1://")
    .replace(/\/+$/, "");
}

function stringOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
}

function credentialsOk(
  provider: AiProviderId,
  apiKey: string | null,
): boolean {
  if (provider === "anthropic" || provider === "openai") return Boolean(apiKey);
  if (provider === "ollama") return true;
  return false;
}

function boolOrDefault(raw: unknown, fallback: boolean): boolean {
  if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
  if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
  return fallback;
}

function positiveIntOrDefault(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
    const n = Number(raw);
    if (n >= 0) return Math.trunc(n);
  }
  return fallback;
}

/** Prefer explicit settings value; missing/null falls back to env. */
function budgetOrEnv(raw: unknown, envFallback: number): number {
  if (raw === undefined || raw === null || raw === "") return envFallback;
  return positiveIntOrDefault(raw, envFallback);
}

/**
 * Parse Settings search_provider.
 * `null` / unset / `"auto"` → no override (env/auto resolution).
 */
export function parseSearchProviderOverride(raw: unknown): SearchProviderId | null {
  if (raw === undefined || raw === null || raw === "" || raw === "auto") return null;
  // Existing installations could persist this removed provider. It previously
  // fell through to DuckDuckGo, so preserve that behavior explicitly.
  if (raw === "searxng") return "duckduckgo";
  if (typeof raw === "string" && isSearchProviderId(raw)) return raw;
  return null;
}

const DEFAULT_OLLAMA_NUM_CTX = 16384;

/** Env `OLLAMA_NUM_CTX` (≥ 2048) or default 16384. */
export function resolveOllamaNumCtx(raw?: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 2048) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
    const n = Number(raw);
    if (n >= 2048) return Math.floor(n);
  }
  const fromEnv = Number(process.env.OLLAMA_NUM_CTX ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 2048) return Math.floor(fromEnv);
  return DEFAULT_OLLAMA_NUM_CTX;
}

function fromEnv(config: ServerConfig): AssistantRuntimeConfig {
  return {
    enabled: config.aiEnabled,
    provider: config.aiProvider,
    anthropicApiKey: config.anthropicApiKey,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    ollamaUrl: config.ollamaUrl,
    aiModel: config.aiModel,
    aiMaxTokens: config.aiMaxTokens,
    useOtherBuildsAsExamples: true,
    aiDailyRequestBudget: config.aiDailyRequestBudget,
    aiDailyTokenBudget: config.aiDailyTokenBudget,
    searchProvider: null,
    searchApiKey: null,
    assistantAllowUrlIngest: config.assistantAllowUrlIngest,
    assistantGuideIngestMaxBytes: config.assistantGuideIngestMaxBytes,
    ollamaNumCtx: resolveOllamaNumCtx(),
    source: config.aiEnabled ? "env" : "none",
  };
}

/**
 * Prefer an enabled Settings → AI Assistant integration when present and valid;
 * otherwise fall back to env (`AI_ENABLED` / `AI_PROVIDER` / keys).
 *
 * User-facing knobs (search, URL ingest, max_tokens, ollama_num_ctx) also prefer
 * Settings fields when set; env remains the operator/SaaS fallback.
 */
export function resolveAssistantRuntime(
  repo: AppRepository,
  env: ServerConfig,
): AssistantRuntimeConfig {
  const items = listIntegrationsByType(repo, "ai_assistant");
  for (const item of items) {
    if (item.config.enabled === false) continue;

    const provider = parseProvider(item.config.provider);
    if (provider === "none") continue;

    const apiKey = stringOrNull(item.config.api_key ?? item.config.apiKey);
    if (!credentialsOk(provider, apiKey)) continue;

    const model = defaultModel(provider, stringOrNull(item.config.model));
    const baseUrl = normalizeUrl(
      item.config.base_url ??
        item.config.ollama_url ??
        item.config.baseUrl ??
        item.config.ollamaUrl,
    );
    const maxTokensRaw = item.config.max_tokens ?? item.config.maxTokens;
    const maxTokens =
      typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
        ? Math.trunc(maxTokensRaw)
        : env.aiMaxTokens;

    const useOtherBuildsAsExamples = boolOrDefault(
      item.config.use_other_builds_as_examples ?? item.config.useOtherBuildsAsExamples,
      true,
    );

    const requestBudget = budgetOrEnv(
      item.config.daily_request_budget ?? item.config.dailyRequestBudget,
      env.aiDailyRequestBudget,
    );
    const tokenBudget = budgetOrEnv(
      item.config.daily_token_budget ?? item.config.dailyTokenBudget,
      env.aiDailyTokenBudget,
    );

    const searchProvider = parseSearchProviderOverride(
      item.config.search_provider ?? item.config.searchProvider,
    );
    const searchKeyRaw = item.config.search_api_key ?? item.config.searchApiKey;
    // Explicit empty string clears override → fall back to env.
    const searchApiKey =
      searchKeyRaw === undefined || searchKeyRaw === null
        ? null
        : stringOrNull(searchKeyRaw);

    const allowUrlRaw =
      item.config.allow_url_ingest ?? item.config.allowUrlIngest;
    const assistantAllowUrlIngest =
      allowUrlRaw === undefined || allowUrlRaw === null
        ? env.assistantAllowUrlIngest
        : boolOrDefault(allowUrlRaw, env.assistantAllowUrlIngest);

    const guideMaxRaw =
      item.config.guide_ingest_max_bytes ?? item.config.guideIngestMaxBytes;
    const assistantGuideIngestMaxBytes =
      guideMaxRaw === undefined || guideMaxRaw === null || guideMaxRaw === ""
        ? env.assistantGuideIngestMaxBytes
        : positiveIntOrDefault(guideMaxRaw, env.assistantGuideIngestMaxBytes);

    const ollamaCtxRaw = item.config.ollama_num_ctx ?? item.config.ollamaNumCtx;
    const ollamaNumCtx =
      ollamaCtxRaw === undefined || ollamaCtxRaw === null || ollamaCtxRaw === ""
        ? resolveOllamaNumCtx()
        : resolveOllamaNumCtx(ollamaCtxRaw);

    return {
      enabled: true,
      provider,
      anthropicApiKey: provider === "anthropic" ? apiKey : null,
      openaiApiKey: provider === "openai" ? apiKey : null,
      openaiBaseUrl:
        provider === "openai" ? baseUrl ?? env.openaiBaseUrl ?? "https://api.openai.com" : null,
      ollamaUrl: provider === "ollama" ? baseUrl ?? env.ollamaUrl : env.ollamaUrl,
      aiModel: model,
      aiMaxTokens: maxTokens,
      useOtherBuildsAsExamples,
      aiDailyRequestBudget: requestBudget,
      aiDailyTokenBudget: tokenBudget,
      searchProvider,
      searchApiKey,
      assistantAllowUrlIngest,
      assistantGuideIngestMaxBytes,
      ollamaNumCtx,
      source: "settings",
    };
  }

  return fromEnv(env);
}
