import {
  HOSTED_TENANT_DISK_QUOTA_BYTES,
  isHostedPlanningDeployMode,
  type DeployMode,
} from "@print-partner/contracts";

export type HostedPlanningPolicy = Readonly<{
  hostedPlanning: boolean;
  allowPrivateOutbound: boolean;
  lanAdapters: boolean;
  tenantDiskQuotaBytes: number | null;
}>;

export function hostedPlanningPolicy(deployMode: DeployMode): HostedPlanningPolicy {
  if (isHostedPlanningDeployMode(deployMode)) {
    return {
      hostedPlanning: true,
      allowPrivateOutbound: false,
      lanAdapters: false,
      tenantDiskQuotaBytes: HOSTED_TENANT_DISK_QUOTA_BYTES,
    };
  }
  return {
    hostedPlanning: false,
    allowPrivateOutbound: true,
    lanAdapters: true,
    tenantDiskQuotaBytes: null,
  };
}
