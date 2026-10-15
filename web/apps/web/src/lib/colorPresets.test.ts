import { describe, expect, it, vi } from "vitest";
import { applyColorPreset } from "./colorPresets";
import * as filamentsApi from "../api/endpoints/filaments";

vi.mock("../api/endpoints/filaments", () => ({
  saveRoleFilament: vi.fn().mockResolvedValue({ updated: 1, thumbnails_cleared: 0, roles: [] }),
}));

describe("applyColorPreset", () => {
  it("rejects presets containing Spoolman assignments when Spoolman is disabled before writing", async () => {
    vi.mocked(filamentsApi.saveRoleFilament).mockClear();
    const preset = {
      type: "print-partner-colors" as const,
      version: 1,
      exported_at: "now",
      roles: [
        {
          role: "body",
          filament_color_id: "spoolman:1:42",
          filament_custom_hex: null,
          spoolman_spool_id: "spoolman:1:99",
        },
      ],
    };

    await expect(
      applyColorPreset(1, preset, { allowSpoolman: () => false }),
    ).rejects.toThrow("Spoolman integration is disabled.");

    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
  });

  it("rejects presets with non-empty spoolman_spool_id even if filament_color_id is not spoolman", async () => {
    vi.mocked(filamentsApi.saveRoleFilament).mockClear();
    const preset = {
      type: "print-partner-colors" as const,
      version: 1,
      exported_at: "now",
      roles: [
        {
          role: "body",
          filament_color_id: "catalog:xyz",
          filament_custom_hex: null,
          spoolman_spool_id: "42",
        },
      ],
    };

    await expect(
      applyColorPreset(1, preset, { allowSpoolman: () => false }),
    ).rejects.toThrow("Spoolman integration is disabled.");

    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
  });

  it("rejects before writing if isCurrent returns false", async () => {
    vi.mocked(filamentsApi.saveRoleFilament).mockClear();
    const preset = {
      type: "print-partner-colors" as const,
      version: 1,
      exported_at: "now",
      roles: [
        {
          role: "body",
          filament_color_id: "catalog:xyz",
          filament_custom_hex: null,
          spoolman_spool_id: null,
        },
      ],
    };

    await expect(
      applyColorPreset(1, preset, { isCurrent: () => false }),
    ).rejects.toThrow("Plan switch or permission changed.");

    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
  });

  it("applies non-Spoolman colors even when Spoolman is disabled", async () => {
    vi.mocked(filamentsApi.saveRoleFilament).mockClear();
    const preset = {
      type: "print-partner-colors" as const,
      version: 1,
      exported_at: "now",
      roles: [
        {
          role: "body",
          filament_color_id: "catalog:xyz",
          filament_custom_hex: null,
          spoolman_spool_id: null,
        },
        {
          role: "accent",
          filament_color_id: null,
          filament_custom_hex: "#112233",
          spoolman_spool_id: null,
        },
      ],
    };

    const count = await applyColorPreset(1, preset, {
      allowSpoolman: () => false,
      isCurrent: () => true,
    });

    expect(count).toBe(2);
    expect(filamentsApi.saveRoleFilament).toHaveBeenCalledTimes(2);
  });

  it("halts mid-loop and does not write further if permission revoked", async () => {
    vi.mocked(filamentsApi.saveRoleFilament).mockClear();
    let currentAllowed = true;
    const preset = {
      type: "print-partner-colors" as const,
      version: 1,
      exported_at: "now",
      roles: [
        {
          role: "body",
          filament_color_id: "catalog:xyz",
          filament_custom_hex: null,
          spoolman_spool_id: null,
        },
        {
          role: "accent",
          filament_color_id: "spoolman:1:5",
          filament_custom_hex: null,
          spoolman_spool_id: null,
        },
      ],
    };

    vi.mocked(filamentsApi.saveRoleFilament).mockImplementationOnce(async () => {
      currentAllowed = false;
      return { updated: 1, thumbnails_cleared: 0, roles: [] };
    });

    await expect(
      applyColorPreset(1, preset, {
        allowSpoolman: () => currentAllowed,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("Spoolman integration is disabled.");

    expect(filamentsApi.saveRoleFilament).toHaveBeenCalledTimes(1);
  });
});
