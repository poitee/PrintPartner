import type { IntegrationSummary } from "../api/endpoints/integrations";
import type { printerLiveStripTone } from "./printerLiveStrip";

export function toneBadgeVariant(
  tone: ReturnType<typeof printerLiveStripTone>,
): "success" | "muted" | "default" | "warning" | "error" {
  switch (tone) {
    case "idle":
    case "complete":
      return "success";
    case "printing":
      return "default";
    case "paused":
      return "warning";
    case "error":
    case "offline":
      return "error";
    default:
      return "muted";
  }
}

export function formatTemperature(current?: number, target?: number): string {
  if (current == null) return "Unavailable";
  const value = `${Math.round(current)}°C`;
  return target != null && target > 0 ? `${value} / ${Math.round(target)}°C` : value;
}

export function formatUptime(seconds?: number): string {
  if (seconds == null) return "Unavailable";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function configuredHost(host: IntegrationSummary): string | undefined {
  const raw = host.config.host ?? host.config.hostname ?? host.config.ip ?? host.config.base_url;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return raw.trim();
  }
}
