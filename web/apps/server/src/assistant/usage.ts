import type { AppRepository } from "../db/repository.js";

const USAGE_KEY = "assistant_daily_usage";

type DailyUsageSnapshot = {
  /** UTC calendar day `YYYY-MM-DD`. */
  date: string;
  requests: number;
  /** Estimated tokens (chars/4) attributed to chat turns today. */
  tokens: number;
};

function utcDayKey(now: Date = new Date()): string {
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
