import { describe, expect, it } from "vitest";
import { validateDiscordWebhookUrl } from "./index.js";

describe("validateDiscordWebhookUrl", () => {
  it("accepts a well-formed Discord webhook URL", () => {
    expect(
      validateDiscordWebhookUrl(
        "https://discord.com/api/webhooks/123456789012345678/aBcDeF-token_123",
      ),
    ).toBeNull();
  });

  it("accepts the discordapp.com legacy domain", () => {
    expect(
      validateDiscordWebhookUrl("https://discordapp.com/api/webhooks/123/tok"),
    ).toBeNull();
  });

  it("accepts ptb./canary. Discord subdomains", () => {
    expect(validateDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/123/tok")).toBeNull();
    expect(validateDiscordWebhookUrl("https://canary.discord.com/api/webhooks/123/tok")).toBeNull();
  });

  it("accepts a trailing slash", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/api/webhooks/123/tok/")).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(validateDiscordWebhookUrl("  https://discord.com/api/webhooks/123/tok  ")).toBeNull();
  });

  it("rejects a plainly invalid string", () => {
    expect(validateDiscordWebhookUrl("not-a-valid-url")).toBeTruthy();
  });

  it("rejects http:// (non-https)", () => {
    expect(validateDiscordWebhookUrl("http://discord.com/api/webhooks/123/tok")).toBeTruthy();
  });

  it("rejects a non-Discord host", () => {
    expect(validateDiscordWebhookUrl("https://evil.example.com/api/webhooks/123/tok")).toBeTruthy();
  });

  it("rejects a non-numeric webhook id", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/api/webhooks/abc/tok")).toBeTruthy();
  });

  it("rejects a missing token", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/api/webhooks/123/")).toBeTruthy();
    expect(validateDiscordWebhookUrl("https://discord.com/api/webhooks/123")).toBeTruthy();
  });

  it("rejects the base discord.com domain without the webhook path", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/")).toBeTruthy();
  });

  it("rejects a webhook URL with extra path segments", () => {
    expect(
      validateDiscordWebhookUrl("https://discord.com/api/webhooks/123/tok/extra"),
    ).toBeTruthy();
  });

  it("returns a human-readable message", () => {
    const error = validateDiscordWebhookUrl("not-a-valid-url");
    expect(error).toMatch(/discord\.com\/api\/webhooks/i);
  });
});
