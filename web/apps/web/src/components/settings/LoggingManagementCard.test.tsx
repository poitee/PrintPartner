// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoggingManagementCard from "./LoggingManagementCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoggingManagementCard", () => {
  it("shows recent workflow requests with their failure details", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/settings/logging/config") {
        return new Response(JSON.stringify({
          minSeverity: "info",
          maxLogs: 10000,
          enableWorkflowTracking: true,
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url === "/settings/logging/stats") {
        return new Response(JSON.stringify({
          totalLogs: 1,
          byMethod: { POST: 1 },
          bySeverity: { debug: 0, info: 0, warn: 1, error: 0 },
          avgDuration: 42,
          errorCount: 0,
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url === "/settings/logging/logs?limit=100") {
        return new Response(JSON.stringify([{
          id: "log-1",
          timestamp: "2026-08-31T22:15:36.721Z",
          method: "POST",
          url: "/plans/12/drafts/40/apply",
          duration: 42,
          statusCode: 422,
          severity: "warn",
          message: "Plan publication did not complete",
          context: { code: "reconciliation_required" },
        }]), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<LoggingManagementCard />);

    expect(await screen.findByText("Recent requests")).toBeTruthy();
    expect(await screen.findByText("/plans/12/drafts/40/apply")).toBeTruthy();
    expect(screen.getByText("422")).toBeTruthy();
    expect(screen.getByText("Plan publication did not complete")).toBeTruthy();
  });

  it("clears a transient viewer error after a successful refresh", async () => {
    let logRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/settings/logging/config") {
        return new Response(JSON.stringify({
          minSeverity: "info",
          maxLogs: 10000,
          enableWorkflowTracking: true,
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url === "/settings/logging/stats") {
        return new Response(JSON.stringify({
          totalLogs: 1,
          byMethod: { GET: 1 },
          bySeverity: { debug: 0, info: 1, warn: 0, error: 0 },
          avgDuration: 2,
          errorCount: 0,
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url === "/settings/logging/logs?limit=100") {
        logRequests += 1;
        if (logRequests === 1) {
          return new Response("", { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify([{
          id: "log-recovered",
          timestamp: "2026-08-31T22:37:21.000Z",
          method: "GET",
          url: "/settings/logging/logs?limit=100",
          duration: 2,
          statusCode: 200,
          severity: "info",
          message: "GET /settings/logging/logs?limit=100",
        }]), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<LoggingManagementCard />);

    expect(await screen.findByText("Unexpected end of JSON input")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh recent logs" }));

    expect(await screen.findByText("/settings/logging/logs?limit=100")).toBeTruthy();
    expect(screen.queryByText("Unexpected end of JSON input")).toBeNull();
  });
});
