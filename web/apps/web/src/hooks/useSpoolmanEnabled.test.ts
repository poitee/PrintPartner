import { describe, expect, it } from "vitest";
import {
  isSpoolmanIntegrationActive,
  isSpoolmanIntegrationConfigured,
} from "./useSpoolmanEnabled";
import type { FilamentCatalog } from "../api/engine";

function catalog(partial: Partial<FilamentCatalog>): FilamentCatalog {
  return {
    synced_at: "",
    source: "test",
    status: "ok",
    colors: [],
    custom_colors: [],
    ...partial,
  };
}

describe("isSpoolmanIntegrationActive", () => {
  it("is false when no default integration", () => {
    expect(isSpoolmanIntegrationActive(catalog({}))).toBe(false);
    expect(isSpoolmanIntegrationActive(null)).toBe(false);
  });

  it("is false when integration is not ok", () => {
    expect(
      isSpoolmanIntegrationActive(
        catalog({
          default_spoolman_integration_id: "abc",
          spoolman_status: "error",
        }),
      ),
    ).toBe(false);
  });

  it("is true when default integration is ok", () => {
    expect(
      isSpoolmanIntegrationActive(
        catalog({
          default_spoolman_integration_id: "abc",
          spoolman_status: "ok",
          spoolman_colors: [
            {
              id: "x",
              display_name: "x",
              product_line: "p",
              hex: "#000",
              combo_label: "x",
              swatch_url: "",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("isSpoolmanIntegrationConfigured", () => {
  it("is false when integration is disabled or missing", () => {
    expect(isSpoolmanIntegrationConfigured(catalog({}))).toBe(false);
    expect(
      isSpoolmanIntegrationConfigured(
        catalog({
          default_spoolman_integration_id: "abc",
          spoolman_status: "disabled",
        }),
      ),
    ).toBe(false);
  });

  it("is true when integration is set even if filament fetch errored", () => {
    expect(
      isSpoolmanIntegrationConfigured(
        catalog({
          default_spoolman_integration_id: "abc",
          spoolman_status: "error",
        }),
      ),
    ).toBe(true);
  });
});
