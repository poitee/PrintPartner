import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchBuildTrackingSettings,
  fetchDateFormatSetting,
  fetchDiscordNotifySettings,
  saveBuildTrackingSettings,
  saveDateFormatSetting,
  saveDiscordNotifySettings,
  testDiscordNotify,
} from "./settings";

const http = createEndpointTestHttp();

describe("settings endpoints", () => {
  it("reads and writes Discord notification settings", async () => {
    http
      .respond(
        jsonResponse({
          webhook_url: null,
          notify_on_update: true,
          notify_on_sync: false,
          auto_sync_updates: false,
        }),
      )
      .respond(
        jsonResponse({
          webhook_url: "https://discord",
          notify_on_update: true,
          notify_on_sync: true,
          auto_sync_updates: false,
        }),
      )
      .respond(jsonResponse({ ok: true }));

    await fetchDiscordNotifySettings();
    await saveDiscordNotifySettings({
      webhook_url: "https://discord",
      notify_on_sync: true,
    });
    await testDiscordNotify();

    expect(http.requestJson(1)).toEqual({
      webhook_url: "https://discord",
      notify_on_sync: true,
    });
    expect(http.requestJson(2)).toEqual({});
  });

  it("reads and writes date format and build tracking", async () => {
    http
      .respond(jsonResponse({ format: "iso" }))
      .respond(jsonResponse({ format: "iso" }))
      .respond(jsonResponse({ assembly_tracking: true }))
      .respond(jsonResponse({ assembly_tracking: false }));

    await fetchDateFormatSetting();
    await saveDateFormatSetting("iso");
    await fetchBuildTrackingSettings();
    await saveBuildTrackingSettings({ assembly_tracking: false });

    expect(http.requestJson(1)).toEqual({ format: "iso" });
    expect(http.requestJson(3)).toEqual({ assembly_tracking: false });
  });
});
