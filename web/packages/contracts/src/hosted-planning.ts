/** Health capability that tells the SPA this process is the invite planning host. */
export const HOSTED_PLANNING_CAPABILITY = "hosted_planning";

export const HOSTED_TENANT_DISK_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export const LAN_INTEGRATION_TYPES = [
  "moonraker",
  "prusalink",
  "bambu",
  "spoolman",
  "slicer_sidecar",
  "home_assistant",
  "ai_assistant",
] as const;

export type LanIntegrationType = (typeof LAN_INTEGRATION_TYPES)[number];

export const HOSTED_LIBRARY_SOURCE_KINDS = ["github", "archive"] as const;

export type HostedLibrarySourceKind = (typeof HOSTED_LIBRARY_SOURCE_KINDS)[number];

export const HOSTED_PLANNING_COMPOSE_NOTE =
  "Live status and send run on a Compose install on the shop LAN. See docs/INSTALL.md.";

export function isHostedPlanningDeployMode(deployMode: "self-host" | "saas"): boolean {
  return deployMode === "saas";
}

export function isHostedPlanning(health: {
  capabilities?: readonly string[] | undefined;
} | null | undefined): boolean {
  return health?.capabilities?.includes(HOSTED_PLANNING_CAPABILITY) === true;
}

export function isLanIntegrationType(type: string): type is LanIntegrationType {
  return (LAN_INTEGRATION_TYPES as readonly string[]).includes(type);
}

export function isHostedLibrarySourceKind(kind: string): kind is HostedLibrarySourceKind {
  return kind === "github" || kind === "archive";
}
