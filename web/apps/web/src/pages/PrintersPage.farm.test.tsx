// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type FeatureSettings, type PlanFeatures } from "@print-partner/contracts";
import PrintersPage from "./PrintersPage";
import { queryKeys } from "../queries/keys";

const state = vi.hoisted(() => ({
  selectedProfileId: 7 as number | null,
}));

const api = vi.hoisted(() => ({
  fetchPrinters: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchPrinterCheckoffLinks: vi.fn(),
  fetchIntegrationStatus: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => 30_000,
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: state.selectedProfileId }),
}));
vi.mock("../api/endpoints/printers", () => ({
  fetchPrinters: api.fetchPrinters,
}));
vi.mock("../api/endpoints/integrations", () => ({
  fetchIntegrations: api.fetchIntegrations,
  fetchIntegrationStatus: api.fetchIntegrationStatus,
}));
vi.mock("../api/endpoints/checkoff", () => ({
  fetchPrinterCheckoffLinks: api.fetchPrinterCheckoffLinks,
}));

const linkedPrinter = {
  id: "printer-1",
  name: "Core One",
  model: "core-one",
  integration_id: "prusa-1",
  enabled: true,
};
const linkedHost = {
  id: "prusa-1",
  name: "Core One",
  type: "prusalink",
  config: { enabled: true },
};
const liveStatus = {
  state: "printing",
  filename: "bracket.bgcode",
  progress: 40,
  nozzle_temperature_c: 210,
  nozzle_target_c: 215,
  bed_temperature_c: 60,
  bed_target_c: 60,
};

function effective(farm: boolean, source: "plan" | "user" | "default") {
  return {
    farm: { enabled: farm, source },
    orders: { enabled: false, source: "default" as const },
    bambu: { enabled: false, source: "default" as const },
    spoolman: { enabled: false, source: "default" as const },
  };
}

function planFeatures(farm: boolean, profileId = 7): PlanFeatures {
  return { profile_id: profileId, overrides: { farm }, effective: effective(farm, "plan") };
}

function accountFeatures(farm: boolean): FeatureSettings {
  return { choices: { farm }, effective: effective(farm, "user") };
}

function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryDefaults(queryKeys.health, { staleTime: Infinity, retry: false });
  return queryClient;
}

function renderPage(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PrintersPage farm visibility", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    state.selectedProfileId = 7;
    api.fetchPrinters.mockReset();
    api.fetchIntegrations.mockReset();
    api.fetchPrinterCheckoffLinks.mockReset();
    api.fetchIntegrationStatus.mockReset();
    api.fetchPrinters.mockResolvedValue([linkedPrinter]);
    api.fetchIntegrations.mockResolvedValue([linkedHost]);
    api.fetchPrinterCheckoffLinks.mockResolvedValue({ links: [] });
    api.fetchIntegrationStatus.mockResolvedValue(liveStatus);
  });

  it("keeps the live strip when feature toggles are not advertised", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    renderPage(queryClient);

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(screen.getByText("Nozzle")).toBeTruthy();
    expect(api.fetchIntegrationStatus).toHaveBeenCalled();
  });

  it("hides the live strip when the Plan's effective farm choice is off", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    queryClient.setQueryData(queryKeys.tenantFeatures, accountFeatures(true));
    renderPage(queryClient);

    expect(await screen.findByRole("button", { name: "Files & tracking" })).toBeTruthy();
    expect(screen.getByText("Core One")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Send from Production" })).toBeTruthy();
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
    expect(screen.queryByText("No active job")).toBeNull();
    expect(screen.queryByText("Nozzle")).toBeNull();
    expect(screen.queryByText("Printing 40%")).toBeNull();
    await waitFor(() => expect(api.fetchPrinters).toHaveBeenCalled());
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
    expect(api.fetchPrinterCheckoffLinks).not.toHaveBeenCalled();
  });

  it("shows the live strip when the Plan's effective farm choice is on", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(true));
    renderPage(queryClient);

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(screen.getByText("Printing 40%")).toBeTruthy();
    expect(screen.getByText("Nozzle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files & tracking" })).toBeTruthy();
    expect(api.fetchIntegrationStatus).toHaveBeenCalledWith("prusa-1");
  });

  it("hides the live strip while Plan features load and after they fail", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    let fail!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/plans/7/features") {
        return new Promise<Response>((_resolve, reject) => {
          fail = () => reject(new Error("boom"));
        });
      }
      return new Promise<Response>(() => {});
    }));
    renderPage(queryClient);

    expect(await screen.findByText("Core One")).toBeTruthy();
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    await act(async () => fail());
    await vi.waitFor(() => expect(queryClient.getQueryState(queryKeys.planFeatures(7))?.status).toBe("error"));
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
    expect(screen.queryByText("Nozzle")).toBeNull();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
  });

  it("hides the live strip for features that belong to another Plan", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(true, 8));
    renderPage(queryClient);

    expect(await screen.findByText("Core One")).toBeTruthy();
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
  });

  it("keeps manual tracking for an unlinked printer when farm is off", async () => {
    api.fetchPrinters.mockResolvedValue([
      { id: "printer-2", name: "Bench", model: "ender-3", enabled: true },
    ]);
    api.fetchIntegrations.mockResolvedValue([]);
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    renderPage(queryClient);

    expect(await screen.findByText("Unmonitored")).toBeTruthy();
    expect(screen.getByText("Provide a print file to track this printer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files & tracking" })).toBeTruthy();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
  });

  it("hides the live strip for the account farm choice when no Plan is selected", async () => {
    state.selectedProfileId = null;
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.tenantFeatures, accountFeatures(false));
    renderPage(queryClient);

    expect(await screen.findByText("Core One")).toBeTruthy();
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
    expect(screen.queryByText("Nozzle")).toBeNull();
    expect(screen.getByRole("button", { name: "Files & tracking" })).toBeTruthy();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
  });

  it("shows the live strip for the account farm choice when no Plan is selected", async () => {
    state.selectedProfileId = null;
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.tenantFeatures, accountFeatures(true));
    renderPage(queryClient);

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(api.fetchIntegrationStatus).toHaveBeenCalledWith("prusa-1");
  });
});
