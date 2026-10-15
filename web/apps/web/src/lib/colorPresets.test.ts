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
  beforeEach(() => vi.mocked(filamentsApi.saveRoleFilament).mockClear());

  it.each([
    { ...catalogRole, filament_color_id: "spoolman:1:42", spoolman_spool_id: "spoolman:1:99" },
    { ...catalogRole, spoolman_spool_id: "42" },
  ])("rejects denied optional assignments before any writes: %j", async (optionalRole) => {
    await expect(applyColorPreset(1, preset([catalogRole, optionalRole]), { allowSpoolman: () => false }))
      .rejects.toThrow("Spoolman integration is disabled.");
    expect(filamentsApi.saveRoleFilament).not.toHaveBeenCalled();
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
    expect(vi.mocked(filamentsApi.saveRoleFilament).mock.calls).toEqual([[1, catalogRole], [1, customRole]]);
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
