// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrinterLiveStrip from "../components/checkoff/PrinterLiveStrip";
import IntegrationsSettingsCard from "../components/settings/IntegrationsSettingsCard";
import PrintersSettingsCard from "../components/settings/PrintersSettingsCard";
import PrintersPage from "../pages/PrintersPage";
import { useProfilesQuery } from "./profiles";

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));

vi.mock("../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => 60_000,
}));

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: null }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const printers = [
  { id: "p1", name: "Voron", model: "voron", integration_id: "moon-1", device_id: "default", enabled: true, loaded_filaments: [] },
  { id: "p2", name: "X1", model: "x1", integration_id: "bambu-1", device_id: "serial", enabled: true, loaded_filaments: [] },
];
const integrations = [
  { id: "moon-1", name: "Voron", type: "moonraker", config: { enabled: true, base_url: "http://voron" }, capabilities: {} },
  { id: "bambu-1", name: "X1", type: "bambu", config: { enabled: true, host: "10.0.0.2" }, capabilities: {} },
  { id: "spool-1", name: "Spoolman", type: "spoolman", config: { enabled: true, base_url: "http://spool" }, capabilities: {} },
];

const bodies: ReadonlyArray<readonly [RegExp, unknown]> = [
  [/^\/printers$/, { printers }],
  [/^\/printer-presets$/, { presets: [] }],
  [/^\/api\/v1\/integrations$/, { integrations }],
  [/^\/api\/v1\/integrations\/[^/]+\/status$/, { state: "idle" }],
  [/^\/printer-checkoff\/reconcile$/, { status: { state: "idle" }, updates: [], created_links: [] }],
  [/^\/printer-checkoff/, { links: [] }],
  [/^\/settings\/printer-plan-bindings$/, { bindings: [] }],
  [/^\/settings\/spoolman-default$/, { integration_id: null }],
  [/^\/plans$/, { profiles: [] }],
  [/^\/filaments\/catalog$/, { materials: [], colors: [] }],
  [/^\/printers\/[^/]+\/profile-assignment$/, { printer_id: "p1", slicer: null, profiles: {} }],
  [/^\/slicer-profile-options/, { printers: [], filaments: [], processes: [] }],
];

let gets: string[] = [];

beforeEach(() => {
  gets = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if ((init?.method ?? "GET") === "GET") gets.push(url.pathname);
    const body = bodies.find(([pattern]) => pattern.test(url.pathname))?.[1] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ProfilesShell() {
  useProfilesQuery();
  return null;
}

function renderScreen(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function settle() {
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function count(path: string): number {
  return gets.filter((candidate) => candidate === path).length;
}

describe("shared reads", () => {
  it("loads the fleet once for the Printers page and the live strip together", async () => {
    renderScreen(
      <>
        <PrintersPage />
        <PrinterLiveStrip engineReady />
      </>,
    );
    await screen.findByText("Voron");
    await settle();

    expect(count("/printers")).toBe(1);
    expect(count("/api/v1/integrations")).toBe(1);
  });

  it("loads each shared resource once for the Settings printer and integration cards", async () => {
    renderScreen(
      <>
        <ProfilesShell />
        <PrintersSettingsCard engineReady />
        <IntegrationsSettingsCard engineReady />
      </>,
    );
    await screen.findAllByText("Voron");
    await settle();

    expect(count("/api/v1/integrations")).toBe(1);
    expect(count("/plans")).toBe(1);
  });
});
