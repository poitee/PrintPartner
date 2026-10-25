import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyColorPreset } from "./colorPresets";
import * as filamentsApi from "../api/endpoints/filaments";

vi.mock("../api/endpoints/filaments", () => ({
  saveRoleFilament: vi.fn().mockResolvedValue({ updated: 1, thumbnails_cleared: 0, roles: [] }),
}));

function preset(roles: Parameters<typeof applyColorPreset>[1]["roles"]) {
  return { type: "print-partner-colors", version: 1, exported_at: "now", roles } satisfies Parameters<typeof applyColorPreset>[1];
}
const catalogRole = { role: "body", filament_color_id: "catalog:xyz", filament_custom_hex: null, spoolman_spool_id: null };

describe("applyColorPreset", () => {
  beforeEach(() => vi.mocked(filamentsApi.saveRoleFilament)
    .mockReset().mockResolvedValue({ updated: 1, thumbnails_cleared: 0, roles: [] }));

  it.each([
    [{ ...catalogRole, filament_color_id: "spoolman:1:42", filament_custom_hex: "#112233", spoolman_spool_id: "spoolman:1:99" }, null],
    [{ ...catalogRole, spoolman_spool_id: "42" }, "catalog:xyz"],
  ] as const)("strips denied Spoolman references and keeps ordinary colors: %j", async (optionalRole, expectedColorId) => {
    const count = await applyColorPreset(1, preset([catalogRole, optionalRole]), { allowSpoolman: () => false });
    expect(count).toBe(2);
    expect(vi.mocked(filamentsApi.saveRoleFilament).mock.calls).toEqual([
      [1, { ...catalogRole, refresh_thumbnails: false }],
      [1, { ...optionalRole, filament_color_id: expectedColorId, spoolman_spool_id: null, refresh_thumbnails: false }],
    ]);
  });

  it("leaves the stored role unchanged when denied stripping removes its entire assignment", async () => {
    const stored = { ...catalogRole };
    vi.mocked(filamentsApi.saveRoleFilament).mockImplementationOnce(async (_profileId, payload) => {
      Object.assign(stored, payload);
      return { updated: 1, thumbnails_cleared: 0, roles: [] };
    });

    const count = await applyColorPreset(1, preset([
      { ...catalogRole, filament_color_id: "spoolman:1:filament:42", spoolman_spool_id: "spoolman:1:spool:99" },
    ]), { allowSpoolman: () => false });

    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
    expect(stored).toEqual(catalogRole);
    expect(count).toBe(0);
  });

  it.each([
    { label: "denied", options: { allowSpoolman: () => false } },
    { label: "allowed", options: { allowSpoolman: () => true } },
    { label: "no options", options: undefined },
  ])("clears an explicitly unassigned preset role with $label access", async ({ options }) => {
    const unassigned = { role: "body", filament_color_id: null, filament_custom_hex: null, spoolman_spool_id: null };

    const count = await applyColorPreset(1, preset([unassigned]), options);

    expect(count).toBe(1);
    expect(vi.mocked(filamentsApi.saveRoleFilament).mock.calls).toEqual([
      [1, { ...unassigned, refresh_thumbnails: false }],
    ]);
  });

  it.each([
    { ...catalogRole, filament_color_id: "spoolman:1:filament:42" },
    { ...catalogRole, filament_color_id: null, spoolman_spool_id: "spoolman:1:spool:99" },
    { ...catalogRole, filament_color_id: null, spoolman_spool_id: "99" },
  ])("skips a denied Spoolman-only assignment but still clears an unassigned role: %j", async (spoolmanRole) => {
    const unassigned = { role: "accent", filament_color_id: null, filament_custom_hex: null, spoolman_spool_id: null };

    const count = await applyColorPreset(1, preset([spoolmanRole, unassigned]), { allowSpoolman: () => false });

    expect(count).toBe(1);
    expect(vi.mocked(filamentsApi.saveRoleFilament).mock.calls).toEqual([
      [1, { ...unassigned, refresh_thumbnails: false }],
    ]);
  });

  it("rejects before writing if isCurrent returns false", async () => {
    await expect(applyColorPreset(1, preset([catalogRole]), { isCurrent: () => false }))
      .rejects.toThrow("Plan switch or permission changed.");
    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
  });

  it("applies non-Spoolman colors even when Spoolman is disabled", async () => {
    const customRole = { ...catalogRole, role: "accent", filament_color_id: null, filament_custom_hex: "#112233" };
    const count = await applyColorPreset(1, preset([catalogRole, customRole]), {
      allowSpoolman: () => false, isCurrent: () => true,
    });
    expect(count).toBe(2);
    expect(vi.mocked(filamentsApi.saveRoleFilament).mock.calls).toEqual([
      [1, { ...catalogRole, refresh_thumbnails: false }],
      [1, { ...customRole, refresh_thumbnails: false }],
    ]);
  });

  it("halts mid-loop and does not write further if permission revoked", async () => {
    let currentAllowed = true;
    vi.mocked(filamentsApi.saveRoleFilament).mockImplementationOnce(async () => {
      currentAllowed = false;
      return { updated: 1, thumbnails_cleared: 0, roles: [] };
    });
    await expect(applyColorPreset(1, preset([catalogRole, { ...catalogRole, role: "accent", filament_color_id: "spoolman:1:5" }]), {
      allowSpoolman: () => currentAllowed, isCurrent: () => true,
    })).rejects.toThrow("Spoolman integration is disabled.");
    expect(filamentsApi.saveRoleFilament).toHaveBeenCalledTimes(1);
  });
});
