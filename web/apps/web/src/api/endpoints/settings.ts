import type { DateFormatId } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export type DiscordNotifySettings = {
  webhook_url: string | null;
  notify_on_update: boolean;
  notify_on_sync: boolean;
  auto_sync_updates: boolean;
};

export type BuildTrackingSettings = {
  assembly_tracking: boolean;
};

export async function fetchDiscordNotifySettings(): Promise<DiscordNotifySettings> {
  return engineFetch<DiscordNotifySettings>("/settings/discord-notify");
}

export async function saveDiscordNotifySettings(
  settings: Partial<DiscordNotifySettings>,
): Promise<DiscordNotifySettings> {
  return engineFetch<DiscordNotifySettings>("/settings/discord-notify", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function testDiscordNotify(): Promise<{ ok: boolean; error?: string }> {
  return engineFetch<{ ok: boolean; error?: string }>("/settings/discord-notify/test", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchDateFormatSetting(): Promise<{ format: DateFormatId }> {
  return engineFetch<{ format: DateFormatId }>("/settings/date-format");
}

export async function saveDateFormatSetting(format: DateFormatId): Promise<{ format: DateFormatId }> {
  return engineFetch<{ format: DateFormatId }>("/settings/date-format", {
    method: "PUT",
    body: JSON.stringify({ format }),
  });
}

export async function fetchBuildTrackingSettings(): Promise<BuildTrackingSettings> {
  return engineFetch<BuildTrackingSettings>("/settings/build-tracking");
}

export async function saveBuildTrackingSettings(
  settings: Partial<BuildTrackingSettings>,
): Promise<BuildTrackingSettings> {
  return engineFetch<BuildTrackingSettings>("/settings/build-tracking", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}
