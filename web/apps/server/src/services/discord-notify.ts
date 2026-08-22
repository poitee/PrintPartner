import { safeOutboundFetch } from "../lib/outbound-url.js";
import type { AcceptedProfileProgress } from "../db/repository.js";
import { getLogger } from "./logger.js";

export type DiscordNotifyEvent =
  | "source.synced"
  | "source.updated"
  | "source.sync_failed"
  | "source.update_available"
  | "farm.digest";

const EVENT_META: Record<
  DiscordNotifyEvent,
  { color: number; emoji: string; titleTemplate: string }
> = {
  "source.synced": {
    color: 0x57f287, // green
    emoji: "✅",
    titleTemplate: "{sourceName} synced",
  },
  "source.updated": {
    color: 0x57f287, // green
    emoji: "🔄",
    titleTemplate: "{sourceName} updated",
  },
  "source.sync_failed": {
    color: 0xed4245, // red
    emoji: "❌",
    titleTemplate: "{sourceName} sync failed",
  },
  "source.update_available": {
    color: 0xfee75c, // yellow
    emoji: "⬆️",
    titleTemplate: "Update available: {sourceName}",
  },
  "farm.digest": {
    color: 0x5865f2, // blurple
    emoji: "🌅",
    titleTemplate: "Good morning — farm digest",
  },
};

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function buildDescription(
  event: DiscordNotifyEvent,
  data: {
    sourceName: string;
    sourceUrl: string;
    branch: string;
    commitSha?: string | null;
    previousSha?: string | null;
    stlCount?: number;
    error?: string;
  },
): string {
  const sha = data.commitSha;
  const short = shortSha(sha);

  switch (event) {
    case "source.synced":
      return [
        `Branch \`${data.branch}\``,
        data.stlCount != null ? `${data.stlCount} STLs` : null,
        sha ? `[${short}](${data.sourceUrl}/commit/${sha})` : null,
      ]
        .filter(Boolean)
        .join(" · ");

    case "source.updated": {
      const prevShort = shortSha(data.previousSha);
      const parts = [`Branch \`${data.branch}\``];
      if (data.stlCount != null) parts.push(`${data.stlCount} STLs`);
      if (sha) {
        if (data.previousSha && data.previousSha !== sha) {
          parts.push(
            `[${prevShort}…${short}](${data.sourceUrl}/compare/${data.previousSha}...${sha})`,
          );
        } else {
          parts.push(`[${short}](${data.sourceUrl}/commit/${sha})`);
        }
      }
      return parts.join(" · ");
    }

    case "source.sync_failed":
      return data.error ? `**Error:** ${data.error}` : "Sync failed — check logs for details.";

    case "source.update_available":
      return [
        `Branch \`${data.branch}\``,
        sha ? `Remote: [${short}](${data.sourceUrl}/commit/${sha})` : null,
      ]
        .filter(Boolean)
        .join(" · ");

    case "farm.digest":
      return data.error ?? "";
  }
}

/** Outcome of a webhook delivery attempt. Callers that care (e.g. the settings
 *  test endpoint) can surface the failure; best-effort callers may ignore it. */
export type DiscordDeliveryResult = {
  ok: boolean;
  /** HTTP status of the final attempt, or null if the request never completed. */
  status: number | null;
  /** Human-readable reason, present only when ok === false. */
  error?: string;
  /** Whether the webhook is permanently unusable (bad/deleted webhook, bad auth).
   *  Distinguishes "reconfigure me" from "transient, will work next time". */
  permanent?: boolean;
  attempts: number;
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 429 = rate limited, 408/5xx = transient. Every other 4xx is a config problem
 *  (401/403 bad auth, 404 webhook deleted, 400 malformed payload) and retrying
 *  it just burns the rate-limit budget. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Discord sends retry_after as float seconds in the JSON body, and mirrors it
 *  in the Retry-After header. Prefer the body, fall back to the header. */
function parseRetryDelayMs(response: Response, bodyText: string): number {
  let seconds: number | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { retry_after?: number };
    if (typeof parsed.retry_after === "number") seconds = parsed.retry_after;
  } catch {
    // body wasn't JSON; fall through to the header
  }
  if (seconds == null) {
    const header = response.headers.get("retry-after");
    if (header) {
      const parsed = Number(header);
      if (Number.isFinite(parsed)) seconds = parsed;
    }
  }
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

function describeFailure(status: number, bodyText: string): string {
  const detail = bodyText.slice(0, 200);
  if (status === 401 || status === 403) {
    return `Discord rejected the webhook token (HTTP ${status}). The webhook was likely regenerated or its permissions changed. ${detail}`;
  }
  if (status === 404) {
    return `Discord webhook no longer exists (HTTP 404) — it was deleted, or the configured URL is wrong. ${detail}`;
  }
  if (status === 429) {
    return `Rate limited by Discord (HTTP 429) and still limited after ${MAX_ATTEMPTS} attempts. ${detail}`;
  }
  return `Discord webhook returned HTTP ${status}. ${detail}`;
}

/**
 * POST a payload to a Discord webhook with bounded retries.
 * Never throws — delivery is best-effort — but always reports what happened so
 * callers can distinguish "delivered", "try again later", and "reconfigure me".
 */
export async function postDiscordWebhook(
  webhookUrl: string,
  payload: unknown,
  logContext: Record<string, unknown> = {},
  deps: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<DiscordDeliveryResult> {
  const logger = getLogger();
  const doSleep = deps.sleepFn ?? sleep;
  let lastError = "Webhook delivery never completed";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await safeOutboundFetch(
        webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
        { allowPrivate: false },
      );
      lastStatus = response.status;

      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt };
      }

      const text = await response.text().catch(() => "");
      lastError = describeFailure(response.status, text);

      if (!isRetryable(response.status)) {
        logger.log("warn", `[discord-notify] ${lastError}`, logContext);
        return {
          ok: false,
          status: response.status,
          error: lastError,
          permanent: true,
          attempts: attempt,
        };
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMs =
          response.status === 429
            ? parseRetryDelayMs(response, text)
            : Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
        logger.log(
          "warn",
          `[discord-notify] HTTP ${response.status} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${delayMs}ms`,
          logContext,
        );
        await doSleep(delayMs);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
        logger.log(
          "warn",
          `[discord-notify] Network error on attempt ${attempt}/${MAX_ATTEMPTS} (${lastError}); retrying in ${delayMs}ms`,
          logContext,
        );
        await doSleep(delayMs);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  logger.log(
    "warn",
    `[discord-notify] Giving up after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    logContext,
  );
  return { ok: false, status: lastStatus, error: lastError, attempts: MAX_ATTEMPTS };
}

export async function sendDiscordNotification(
  webhookUrl: string,
  event: DiscordNotifyEvent,
  data: {
    sourceName: string;
    sourceUrl: string;
    branch: string;
    commitSha?: string | null;
    previousSha?: string | null;
    stlCount?: number;
    error?: string;
  },
): Promise<DiscordDeliveryResult> {
  const meta = EVENT_META[event];
  const title = `${meta.emoji} ${meta.titleTemplate.replace("{sourceName}", data.sourceName)}`;
  const description = buildDescription(event, data);
  const timestamp = new Date().toISOString();

  const payload = {
    embeds: [
      {
        color: meta.color,
        author: { name: "Print Partner" },
        title,
        description,
        url: data.sourceUrl || undefined,
        footer: { text: `Print Partner · ${new Date().toLocaleString()}` },
        timestamp,
      },
    ],
  };

  return postDiscordWebhook(webhookUrl, payload, {
    event,
    sourceName: data.sourceName,
  });
}

export type FarmDigestData = {
  platesOvernight: number;
  windowHours: number;
  printers: Array<{ name: string; state: string; active_job?: string | null }>;
  activePlans: FarmDigestPlanCollection;
};

export type FarmDigestPlan = {
  readonly plan_name: string;
  readonly progress: AcceptedProfileProgress;
};

export type FarmDigestPlanCollection =
  | { readonly kind: "available"; readonly plans: readonly FarmDigestPlan[] }
  | { readonly kind: "unavailable" };

function buildDigestDescription(d: FarmDigestData): string {
  const lines: string[] = [];
  const windowLabel = d.windowHours === 8 ? "overnight" : `last ${d.windowHours}h`;
  lines.push(`**${d.platesOvernight}** plate(s) sent to printers ${windowLabel}.`);

  if (d.printers.length > 0) {
    lines.push("");
    lines.push("**Printers:**");
    for (const p of d.printers) {
      const stateEmoji =
        p.state === "printing" || p.state === "paused"
          ? "🖨️"
          : p.state === "idle" || p.state === "complete"
          ? "✅"
          : "⚫";
      const jobNote = p.active_job ? ` — \`${p.active_job}\`` : "";
      lines.push(`${stateEmoji} **${p.name}** ${p.state}${jobNote}`);
    }
  }

  if (d.activePlans.kind === "unavailable") {
    lines.push("");
    lines.push("**Plans:**");
    lines.push("Plan progress unavailable");
  } else if (d.activePlans.plans.length > 0) {
    lines.push("");
    lines.push("**Plans:**");
    for (const plan of d.activePlans.plans.slice(0, 5)) {
      lines.push(`• ${plan.plan_name}: ${farmDigestProgressText(plan.progress)}`);
    }
    if (d.activePlans.plans.length > 5) {
      lines.push(`_…and ${d.activePlans.plans.length - 5} more_`);
    }
  }

  return lines.join("\n");
}

function farmDigestProgressText(
  progress: AcceptedProfileProgress,
): string {
  switch (progress.kind) {
    case "ready":
      return progress.totalUnits === 0
        ? "No required units"
        : `**${progress.remainingUnits}** units remaining`;
    case "empty":
      return "Not applied";
    case "unavailable":
    case "integrity_failure":
    case "concurrent_update":
      return "Progress unavailable";
  }
}

export async function sendFarmDigest(
  webhookUrl: string,
  data: FarmDigestData,
): Promise<DiscordDeliveryResult> {
  const meta = EVENT_META["farm.digest"];
  const description = buildDigestDescription(data);
  const timestamp = new Date().toISOString();

  const payload = {
    embeds: [
      {
        color: meta.color,
        author: { name: "Print Partner" },
        title: `${meta.emoji} ${meta.titleTemplate}`,
        description,
        footer: { text: `Print Partner · ${new Date().toLocaleString()}` },
        timestamp,
      },
    ],
  };

  return postDiscordWebhook(webhookUrl, payload, { event: "farm.digest" });
}
