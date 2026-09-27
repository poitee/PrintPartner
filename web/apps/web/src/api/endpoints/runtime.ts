import { formatTimestamp } from "@print-partner/contracts";
import { getEngineBaseUrl } from "../contractRequest";

export function formatSyncTime(iso: string): string {
  return formatTimestamp(iso);
}

export async function engineBaseUrl(): Promise<string> {
  return getEngineBaseUrl();
}

export function shortSha(sha: string | null): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}
