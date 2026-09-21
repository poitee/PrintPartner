import { describe, expect, it } from "vitest";
import {
  HOSTED_PLANNING_CAPABILITY,
  HOSTED_TENANT_DISK_QUOTA_BYTES,
  isHostedLibrarySourceKind,
  isHostedPlanning,
  isHostedPlanningDeployMode,
  isLanIntegrationType,
} from "./hosted-planning.js";

describe("hosted planning cut", () => {
  it("treats saas as the hosted planning host", () => {
    expect(isHostedPlanningDeployMode("saas")).toBe(true);
    expect(isHostedPlanningDeployMode("self-host")).toBe(false);
  });

  it("reads the hosted_planning health capability", () => {
    expect(isHostedPlanning({ capabilities: [HOSTED_PLANNING_CAPABILITY] })).toBe(true);
    expect(isHostedPlanning({ capabilities: ["kit_planning"] })).toBe(false);
    expect(isHostedPlanning(null)).toBe(false);
  });

  it("names LAN adapters the hosted host must refuse", () => {
    expect(isLanIntegrationType("moonraker")).toBe(true);
    expect(isLanIntegrationType("prusalink")).toBe(true);
    expect(isLanIntegrationType("bambu")).toBe(true);
    expect(isLanIntegrationType("spoolman")).toBe(true);
    expect(isLanIntegrationType("slicer_sidecar")).toBe(true);
    expect(isLanIntegrationType("home_assistant")).toBe(true);
    expect(isLanIntegrationType("ai_assistant")).toBe(true);
    expect(isLanIntegrationType("webhook")).toBe(false);
  });

  it("keeps GitHub and zip as the hosted library kinds", () => {
    expect(isHostedLibrarySourceKind("github")).toBe(true);
    expect(isHostedLibrarySourceKind("archive")).toBe(true);
    expect(isHostedLibrarySourceKind("local")).toBe(false);
    expect(isHostedLibrarySourceKind("printables")).toBe(false);
  });

  it("caps tenant disk at 2 GiB", () => {
    expect(HOSTED_TENANT_DISK_QUOTA_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
