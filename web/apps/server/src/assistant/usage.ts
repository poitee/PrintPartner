import type { AppRepository } from "../db/repository.js";

const USAGE_KEY = "assistant_daily_usage";

export type DailyUsageSnapshot = {
  /** UTC calendar day `YYYY-MM-DD`. */
  date: string;
  requests: number;
  /** Estimated tokens (chars/4) attributed to chat turns today. */
  tokens: number;
};

export type BudgetLimits = {
  /** Max chat requests per tenant per UTC day. `0` = unlimited. */
  requestBudget: number;
  /** Max estimated tokens per tenant per UTC day. `0` = unlimited. */
  tokenBudget: number;
};

export type BudgetCheckResult =
  | { ok: true; usage: DailyUsageSnapshot }
  | { ok: false; usage: DailyUsageSnapshot; detail: string };

/** Rough token estimate without a tokenizer — good enough for soft caps. */
export function estimateTokens(text: string): number {
  const len = text.length;
  if (len <= 0) return 0;
  return Math.ceil(len / 4);
}

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function loadDailyUsage(
  repo: AppRepository,
  now: Date = new Date(),
): DailyUsageSnapshot {
  const today = utcDayKey(now);
  const raw = repo.getSetting(USAGE_KEY);
  if (!raw) return { date: today, requests: 0, tokens: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<DailyUsageSnapshot>;
    if (
      typeof parsed.date === "string" &&
      parsed.date === today &&
      typeof parsed.requests === "number" &&
      typeof parsed.tokens === "number"
    ) {
      return {
        date: today,
        requests: Math.max(0, Math.trunc(parsed.requests)),
        tokens: Math.max(0, Math.trunc(parsed.tokens)),
      };
    }
  } catch {
    /* reset */
  }
  return { date: today, requests: 0, tokens: 0 };
}

function saveDailyUsage(repo: AppRepository, usage: DailyUsageSnapshot): void {
  repo.setSetting(USAGE_KEY, JSON.stringify(usage));
}

/**
 * Gate a chat turn against per-tenant daily budgets.
 * `estimatedTokens` is the additional tokens this turn is expected to consume.
 */
export function checkDailyBudget(
  repo: AppRepository,
  limits: BudgetLimits,
  estimatedTokens: number,
  now: Date = new Date(),
): BudgetCheckResult {
  const usage = loadDailyUsage(repo, now);
  const reqLimit = limits.requestBudget > 0 ? limits.requestBudget : 0;
  const tokLimit = limits.tokenBudget > 0 ? limits.tokenBudget : 0;

  if (reqLimit > 0 && usage.requests >= reqLimit) {
    return {
      ok: false,
      usage,
      detail: `Daily assistant request budget exceeded (${usage.requests}/${reqLimit}). Try again tomorrow or raise AI_DAILY_REQUEST_BUDGET / Settings daily_request_budget.`,
    };
  }

  if (tokLimit > 0 && usage.tokens + Math.max(0, estimatedTokens) > tokLimit) {
    return {
      ok: false,
      usage,
      detail: `Daily assistant token budget exceeded (${usage.tokens}/${tokLimit} used). Try again tomorrow or raise AI_DAILY_TOKEN_BUDGET / Settings daily_token_budget.`,
    };
  }

  return { ok: true, usage };
}

/** Record one completed chat turn against today's counters. */
export function recordDailyUsage(
  repo: AppRepository,
  tokensUsed: number,
  now: Date = new Date(),
): DailyUsageSnapshot {
  const usage = loadDailyUsage(repo, now);
  const next: DailyUsageSnapshot = {
    date: usage.date,
    requests: usage.requests + 1,
    tokens: usage.tokens + Math.max(0, Math.trunc(tokensUsed)),
  };
  saveDailyUsage(repo, next);
  return next;
}
