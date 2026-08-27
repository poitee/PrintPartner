import { formatTimestamp } from "@print-partner/contracts";
import { getEngineBaseUrl } from "../contractRequest";
import { fetchHealth } from "./help";

export function formatSyncTime(iso: string): string {
  return formatTimestamp(iso);
}

export async function engineBaseUrl(): Promise<string> {
  return getEngineBaseUrl();
}

export async function ensureEngineRunning(): Promise<void> {
  try {
    await fetchHealth();
  } catch {
    throw new Error("API server is not reachable. Start the server with `npm run dev` from web/.");
  }
}

export function shortSha(sha: string | null): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}
