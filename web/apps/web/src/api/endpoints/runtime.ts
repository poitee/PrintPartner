import { formatTimestamp } from "@print-partner/contracts";
import { getEngineBaseUrl } from "../contractRequest";

export function formatSyncTime(iso: string): string {
  return formatTimestamp(iso);
}

export async function engineBaseUrl(): Promise<string> {
  return getEngineBaseUrl();
}
