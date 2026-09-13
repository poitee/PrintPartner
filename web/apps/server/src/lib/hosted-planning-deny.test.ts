import { describe, expect, it } from "vitest";
import {
  HOSTED_FEATURE_DISABLED_DETAIL,
  HOSTED_LAN_DISABLED_DETAIL,
  hostedDeniedRouteDetail,
  normalizeHostedApiPath,
} from "./hosted-planning-deny.js";

describe("hostedDeniedRouteDetail", () => {
  it("strips the versioned API prefix", () => {
    expect(normalizeHostedApiPath("/api/v1/integrations")).toBe("/integrations");
    expect(normalizeHostedApiPath("/integrations?x=1")).toBe("/integrations");
  });

  it("denies LAN adapter and send routes a tenant could curl", () => {
    expect(hostedDeniedRouteDetail("POST", "/integrations")).toBe(HOSTED_LAN_DISABLED_DETAIL);
    expect(hostedDeniedRouteDetail("POST", "/api/v1/integrations")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/integrations/abc/test")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("GET", "/integrations/abc/status")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/jobs/printer-upload")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/printer-send-queue")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("GET", "/printers/p1/files")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("GET", "/printers/p1/cameras/view")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/bambu-connect/handoff")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/printer-checkoff/reconcile")).toBe(
      HOSTED_LAN_DISABLED_DETAIL,
    );
  });

  it("denies hosted-only product cuts that are not LAN adapters", () => {
    expect(hostedDeniedRouteDetail("POST", "/webhooks")).toBe(HOSTED_FEATURE_DISABLED_DETAIL);
    expect(hostedDeniedRouteDetail("PUT", "/settings/github-pat")).toBe(
      HOSTED_FEATURE_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("PUT", "/settings/discord-notify")).toBe(
      HOSTED_FEATURE_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/slicer-instances/orca/open-accepted-plates")).toBe(
      HOSTED_FEATURE_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("GET", "/backups")).toBe(HOSTED_FEATURE_DISABLED_DETAIL);
    expect(hostedDeniedRouteDetail("GET", "/backups/foo.tar.gz")).toBe(
      HOSTED_FEATURE_DISABLED_DETAIL,
    );
    expect(hostedDeniedRouteDetail("POST", "/api/v1/mcp")).toBe(HOSTED_FEATURE_DISABLED_DETAIL);
    expect(hostedDeniedRouteDetail("GET", "/settings/api-keys")).toBe(
      HOSTED_FEATURE_DISABLED_DETAIL,
    );
  });

  it("leaves planning routes alone", () => {
    expect(hostedDeniedRouteDetail("GET", "/integrations")).toBeNull();
    expect(hostedDeniedRouteDetail("GET", "/printers")).toBeNull();
    expect(hostedDeniedRouteDetail("POST", "/printers")).toBeNull();
    expect(hostedDeniedRouteDetail("POST", "/sources")).toBeNull();
    expect(hostedDeniedRouteDetail("POST", "/jobs/export-accepted-plate-3mf")).toBeNull();
    expect(hostedDeniedRouteDetail("GET", "/health")).toBeNull();
  });
});
