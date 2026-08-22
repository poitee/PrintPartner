import { describe, expect, it } from "vitest";
import {
  canUseRecoveryTools,
  canUseSettingsResource,
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
  resolveSettingsResourceDisplay,
  shouldMountPlanTools,
} from "./workflowState";

describe("resolveEngineState", () => {
  it("keeps an in-flight health request distinct from an unhealthy response", () => {
    expect(resolveEngineState({ health: null, loading: true, error: null })).toBe("loading");
    expect(resolveEngineState({ health: { ok: false }, loading: false, error: null })).toBe(
      "offline",
    );
  });

  it("treats a failed health request as offline", () => {
    expect(resolveEngineState({ health: null, loading: false, error: "connection refused" })).toBe(
      "offline",
    );
  });

  it("keeps a cached healthy response usable during a background failure", () => {
    expect(
      resolveEngineState({
        health: { ok: true },
        loading: false,
        error: "background refresh failed",
      }),
    ).toBe("ready");
  });
});

describe("resolveResourceState", () => {
  it("preserves cached data during loading and failed background refetches", () => {
    expect(resolveResourceState({ loading: true, error: null, hasData: true })).toBe("ready");
    expect(resolveResourceState({ loading: false, error: "refresh failed", hasData: true })).toBe(
      "ready",
    );
    expect(getBackgroundError("refresh failed", true)).toBe("refresh failed");
  });

  it("blocks only initial loading and initial failure", () => {
    expect(resolveResourceState({ loading: true, error: null, hasData: false })).toBe("loading");
    expect(resolveResourceState({ loading: false, error: "failed", hasData: false })).toBe(
      "error",
    );
  });

  it("keeps an auxiliary category failure non-blocking", () => {
    const primaryState = resolveResourceState({
      loading: false,
      error: null,
      hasData: true,
    });

    expect(primaryState).toBe("ready");
    expect(getBackgroundError("Could not load source categories", true)).toBe(
      "Could not load source categories",
    );
  });
});

describe("settings and plan gates", () => {
  it("shows a background settings error without disabling cached data", () => {
    const resource = {
      loading: false,
      error: "refresh failed",
      hasData: true,
    };

    expect(resolveSettingsResourceDisplay(resource)).toBe("background-error");
    expect(canUseSettingsResource("ready", resource)).toBe(true);
  });

  it("distinguishes initial settings loading and failure from ready data", () => {
    expect(
      resolveSettingsResourceDisplay({
        loading: true,
        error: null,
        hasData: false,
      }),
    ).toBe("loading");
    expect(
      resolveSettingsResourceDisplay({
        loading: false,
        error: "initial failure",
        hasData: false,
      }),
    ).toBe("initial-error");
    expect(
      resolveSettingsResourceDisplay({
        loading: true,
        error: null,
        hasData: true,
      }),
    ).toBe("ready");
  });

  it("does not let one settings endpoint disable another card or recovery tools", () => {
    const engineState = resolveEngineState({
      health: { ok: true },
      loading: false,
      error: null,
    });

    expect(
      canUseSettingsResource(engineState, {
        loading: false,
        error: "GitHub PAT failed",
        hasData: false,
      }),
    ).toBe(false);
    expect(
      canUseSettingsResource(engineState, {
        loading: false,
        error: null,
        hasData: true,
      }),
    ).toBe(true);
    expect(canUseRecoveryTools(engineState)).toBe(true);
  });

  it("never mounts plan tools without an active plan", () => {
    expect(shouldMountPlanTools("ready", null)).toBe(false);
    expect(shouldMountPlanTools("ready", 17)).toBe(true);
    expect(shouldMountPlanTools("offline", 17)).toBe(false);
  });
});
