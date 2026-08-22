import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as outbound from "../lib/outbound-url.js";
import { postDiscordWebhook, sendFarmDigest } from "./discord-notify.js";

/**
 * Regression coverage for kanban t_aeff2492 (Discord webhook for #print-partner).
 *
 * The original failure was invisible: delivery errors were logged and swallowed,
 * so a webhook that Discord rejected looked identical to a healthy one. These
 * tests pin the auth / rate-limit / retry behaviour that makes failures reportable.
 */

function makeResponse(status: number, body = "", headers: Record<string, string> = {}): Response {
  // 204/205/304 are forbidden from carrying a body — the Response constructor
  // throws if you pass even an empty string.
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  return new Response(nullBodyStatus ? null : body, { status, headers });
}

// Never actually sleep in tests — assert on the requested delay instead.
const noSleep = { sleepFn: async () => {} };

describe("postDiscordWebhook", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(outbound, "safeOutboundFetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports success on 204 (Discord's normal webhook response)", async () => {
    fetchSpy.mockResolvedValue(makeResponse(204));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.attempts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats 401 as a permanent auth failure and does NOT retry", async () => {
    fetchSpy.mockResolvedValue(makeResponse(401, '{"message":"Invalid Webhook Token"}'));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/rejected the webhook token/i);
    // Retrying bad auth just burns rate-limit budget.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats 404 (deleted webhook) as permanent — this was the original outage mode", async () => {
    fetchSpy.mockResolvedValue(makeResponse(404, '{"message":"Unknown Webhook"}'));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toMatch(/no longer exists/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds, honouring retry_after from the body", async () => {
    const delays: number[] = [];
    fetchSpy
      .mockResolvedValueOnce(makeResponse(429, '{"retry_after":0.25}'))
      .mockResolvedValueOnce(makeResponse(204));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, {
      sleepFn: async (ms: number) => {
        delays.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    // 0.25s in the body -> 250ms wait, not a hardcoded backoff.
    expect(delays).toEqual([250]);
  });

  it("falls back to the Retry-After header when the 429 body has no retry_after", async () => {
    const delays: number[] = [];
    fetchSpy
      .mockResolvedValueOnce(makeResponse(429, "rate limited", { "retry-after": "2" }))
      .mockResolvedValueOnce(makeResponse(204));

    await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, {
      sleepFn: async (ms: number) => {
        delays.push(ms);
      },
    });

    expect(delays).toEqual([2000]);
  });

  it("gives up after 3 attempts when rate limiting never clears", async () => {
    fetchSpy.mockResolvedValue(makeResponse(429, '{"retry_after":0.01}'));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.permanent).toBeUndefined(); // transient, not a config problem
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries transient 5xx errors", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(204));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("never throws on network failure — returns a failed result instead", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await postDiscordWebhook("https://discord.com/api/webhooks/1/tok", {}, {}, noSleep);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.attempts).toBe(3);
  });
});

describe("sendFarmDigest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces delivery failure to the caller so the cron job can log it", async () => {
    vi.spyOn(outbound, "safeOutboundFetch").mockResolvedValue(
      makeResponse(401, '{"message":"Invalid Webhook Token"}'),
    );

    const result = await sendFarmDigest("https://discord.com/api/webhooks/1/tok", {
      platesOvernight: 3,
      windowHours: 8,
      printers: [{ name: "Prusa XL", state: "idle" }],
      activePlans: {
        kind: "available",
        plans: [
          {
            plan_name: "Trident R2 LDO",
            progress: { kind: "ready", totalUnits: 200, remainingUnits: 189 },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);
  });

  it("posts an embed containing the digest facts on success", async () => {
    const spy = vi
      .spyOn(outbound, "safeOutboundFetch")
      .mockResolvedValue(makeResponse(204));

    const result = await sendFarmDigest("https://discord.com/api/webhooks/1/tok", {
      platesOvernight: 3,
      windowHours: 8,
      printers: [{ name: "Prusa XL", state: "idle" }],
      activePlans: {
        kind: "available",
        plans: [
          {
            plan_name: "Trident R2 LDO",
            progress: { kind: "ready", totalUnits: 200, remainingUnits: 189 },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    const description = body.embeds[0].description as string;
    expect(description).toContain("3");
    expect(description).toContain("Prusa XL");
    expect(description).toContain("189");
  });

  it("renders every accepted state in name order and applies the five-Plan cap", async () => {
    const spy = vi.spyOn(outbound, "safeOutboundFetch").mockResolvedValue(makeResponse(204));
    await sendFarmDigest("https://discord.com/api/webhooks/1/tok", {
      platesOvernight: 0,
      windowHours: 8,
      printers: [],
      activePlans: {
        kind: "available",
        plans: [
          { plan_name: "A Ready", progress: { kind: "ready", totalUnits: 3, remainingUnits: 2 } },
          { plan_name: "B Zero", progress: { kind: "ready", totalUnits: 0, remainingUnits: 0 } },
          { plan_name: "C Empty", progress: { kind: "empty" } },
          { plan_name: "D Dirty", progress: { kind: "unavailable", reason: "compatibility_dirty" } },
          { plan_name: "E Integrity", progress: { kind: "integrity_failure", code: "progress" } },
          { plan_name: "F Concurrent", progress: { kind: "concurrent_update" } },
        ],
      },
    });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.embeds[0].description).toContain(
      "• A Ready: **2** units remaining\n• B Zero: No required units\n• C Empty: Not applied\n• D Dirty: Progress unavailable\n• E Integrity: Progress unavailable\n_…and 1 more_",
    );
    expect(body.embeds[0].description).not.toContain("F Concurrent:");
  });

  it("renders one collection-unavailable line while preserving other sections", async () => {
    const spy = vi.spyOn(outbound, "safeOutboundFetch").mockResolvedValue(makeResponse(204));
    await sendFarmDigest("https://discord.com/api/webhooks/1/tok", {
      platesOvernight: 3,
      windowHours: 8,
      printers: [{ name: "Prusa XL", state: "idle" }],
      activePlans: { kind: "unavailable" },
    });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    const description = body.embeds[0].description as string;
    expect(description).toContain("3");
    expect(description).toContain("Prusa XL");
    expect(description).toContain("Plan progress unavailable");
  });
});
