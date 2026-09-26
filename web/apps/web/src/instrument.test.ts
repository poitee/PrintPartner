import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  reactRouterV7BrowserTracingIntegration: vi.fn(() => ({ name: "router-tracing" })),
}));

describe("browser error reporting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([undefined, "", "   "])("does not initialize Sentry without a DSN (%s)", async (dsn) => {
    if (dsn !== undefined) vi.stubEnv("VITE_SENTRY_DSN", dsn);
    else vi.stubEnv("VITE_SENTRY_DSN", undefined);
    const { sentryEnabled } = await import("./instrument");
    expect(sentryEnabled).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initializes tracing with the configured DSN", async () => {
    const dsn = "https://public@example.invalid/42";
    vi.stubEnv("VITE_SENTRY_DSN", ` ${dsn} `);
    const { sentryEnabled } = await import("./instrument");
    expect(sentryEnabled).toBe(true);
    expect(Sentry.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      dsn,
      environment: import.meta.env.MODE,
      integrations: [{ name: "router-tracing" }],
    }));
  });
});
