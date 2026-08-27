import { describe, expect, it } from "vitest";
import type { IntegrationSummary } from "../api/endpoints/integrations";
import {
  configuredHost,
  formatTemperature,
  formatUptime,
  toneBadgeVariant,
} from "./printersPageModel";

function integration(config: IntegrationSummary["config"]): IntegrationSummary {
  return {
    id: "1",
    name: "Host",
    type: "moonraker",
    config,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

describe("printersPageModel", () => {
  it("maps live printer tones to badge variants", () => {
    expect(toneBadgeVariant("idle")).toBe("success");
    expect(toneBadgeVariant("printing")).toBe("default");
    expect(toneBadgeVariant("paused")).toBe("warning");
    expect(toneBadgeVariant("offline")).toBe("error");
  });

  it("formats temperatures", () => {
    expect(formatTemperature()).toBe("Unavailable");
    expect(formatTemperature(209.6)).toBe("210°C");
    expect(formatTemperature(209.6, 215.1)).toBe("210°C / 215°C");
  });

  it("formats uptime", () => {
    expect(formatUptime()).toBe("Unavailable");
    expect(formatUptime(59)).toBe("0m");
    expect(formatUptime(3_900)).toBe("1h 5m");
    expect(formatUptime(90_000)).toBe("1d 1h");
  });

  it("extracts configured host labels", () => {
    expect(configuredHost(integration({ host: "http://printer.local:7125" }))).toBe(
      "printer.local",
    );
    expect(configuredHost(integration({ ip: "192.168.1.5" }))).toBe("192.168.1.5");
    expect(configuredHost(integration({}))).toBeUndefined();
  });
});
