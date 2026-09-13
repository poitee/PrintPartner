import { describe, expect, it } from "vitest";
import { HOSTED_TENANT_DISK_QUOTA_BYTES } from "@print-partner/contracts";
import { hostedPlanningPolicy } from "./hosted-planning.js";

describe("hostedPlanningPolicy", () => {
  it("disables LAN adapters and private outbound on saas", () => {
    expect(hostedPlanningPolicy("saas")).toEqual({
      hostedPlanning: true,
      allowPrivateOutbound: false,
      lanAdapters: false,
      tenantDiskQuotaBytes: HOSTED_TENANT_DISK_QUOTA_BYTES,
    });
  });

  it("keeps the shop loop on self-host", () => {
    expect(hostedPlanningPolicy("self-host")).toEqual({
      hostedPlanning: false,
      allowPrivateOutbound: true,
      lanAdapters: true,
      tenantDiskQuotaBytes: null,
    });
  });
});
