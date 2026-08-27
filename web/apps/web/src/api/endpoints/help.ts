import type { AppUpdateCheckResponse, HealthResponse } from "@print-partner/contracts";
import { engineFetch, engineFetchText } from "../engineTransport";

export async function fetchHealth(): Promise<HealthResponse> {
  return engineFetch<HealthResponse>("/health");
}

export async function fetchAppUpdateCheck(refresh = false): Promise<AppUpdateCheckResponse> {
  const suffix = refresh ? "?refresh=1" : "";
  return engineFetch<AppUpdateCheckResponse>(`/settings/update-check${suffix}`);
}

export async function fetchLegalDocument(
  name: "summary" | "license" | "attribution" | "third-party",
): Promise<string> {
  return engineFetchText(`/legal/${name}`);
}

export async function fetchWorkflowGuide(): Promise<string> {
  return engineFetchText("/help/workflow");
}
