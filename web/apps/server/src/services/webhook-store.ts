import { createHmac } from "node:crypto";
import type { WebhookRegistration, WebhookEvent } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { assertSafeOutboundUrl, safeOutboundFetch, OutboundUrlError } from "../lib/outbound-url.js";
import { getLogger } from "./logger.js";

const SETTINGS_KEY = "integration_webhooks_v1";

function loadAll(repo: AppRepository): WebhookRegistration[] {
  const raw = repo.getSetting(SETTINGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as WebhookRegistration[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(repo: AppRepository, items: WebhookRegistration[]): void {
  repo.setSetting(SETTINGS_KEY, JSON.stringify(items));
}

export function listWebhooks(repo: AppRepository): WebhookRegistration[] {
  return loadAll(repo);
}

/**
 * Validate and create a webhook with SSRF protection.
 * Throws OutboundUrlError if the URL is unsafe.
 */
export async function createWebhook(
  repo: AppRepository,
  input: { url: string; events: WebhookRegistration["events"]; secret?: string | null },
): Promise<WebhookRegistration> {
  const url = input.url.trim();
  
  // Validate URL is safe to POST to (SSRF guard)
  try {
    await assertSafeOutboundUrl(url, { 
      // Allow private IPs for LAN webhooks (Home Assistant, etc.)
      allowPrivate: true 
    });
  } catch (error) {
    const message = error instanceof OutboundUrlError ? error.message : "Invalid URL";
    throw new OutboundUrlError(`Webhook URL validation failed: ${message}`);
  }

  const row: WebhookRegistration = {
    id: `wh-${crypto.randomUUID().slice(0, 12)}`,
    url,
    events: input.events.length ? input.events : ["job.done", "job.error"],
    secret: input.secret ?? null,
    created_at: new Date().toISOString(),
  };
  const all = loadAll(repo);
  all.push(row);
  saveAll(repo, all);
  return row;
}

export function deleteWebhook(repo: AppRepository, id: string): boolean {
  const all = loadAll(repo);
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  saveAll(repo, next);
  return true;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * Uses the format: sha256=<hex>
 */
function generateSignature(payload: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Dispatch webhooks with:
 * - SSRF validation on every send
 * - HMAC-SHA256 signatures (not plaintext secrets)
 * - Error logging for debugging
 * - Timeout protection
 */
export async function dispatchWebhooks(
  repo: AppRepository,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const logger = getLogger();
  const hooks = loadAll(repo).filter((h) => h.events.includes(event));

  await Promise.all(
    hooks.map(async (hook) => {
      try {
        // Validate URL is safe every time (catches DNS rebinding, etc.)
        await assertSafeOutboundUrl(hook.url, { allowPrivate: true });

        const body = JSON.stringify({ event, ...payload });
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Print-Partner-Event": event,
        };

        // Add HMAC signature if secret is configured
        if (hook.secret) {
          headers["X-Print-Partner-Signature"] = generateSignature(body, hook.secret);
        }

        // Use safe fetch with redirect validation
        const response = await safeOutboundFetch(hook.url, 
          {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
          },
          { allowPrivate: true }
        );

        // Log webhook delivery
        logger.logWorkflow({
          method: "POST",
          url: hook.url,
          duration: 0,
          statusCode: response.status,
          severity: response.ok ? "info" : "warn",
          message: `Webhook delivered: ${event} to ${hook.url}`,
          context: {
            webhookId: hook.id,
            event,
            statusCode: response.status,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        logger.logWorkflow({
          method: "POST",
          url: hook.url,
          duration: 0,
          statusCode: 0,
          severity: "warn",
          message: `Webhook delivery failed: ${event}`,
          error: {
            message: errorMessage,
          },
          context: {
            webhookId: hook.id,
            event,
          },
        });
      }
    }),
  );
}
