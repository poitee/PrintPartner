// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type FeatureSettings, type PlanFeatures, type PrinterSendQueueItem } from "@print-partner/contracts";
import PrinterSendQueuePanel from "./PrinterSendQueuePanel";
import { queryKeys } from "../../queries/keys";

const fetchPrinterSendQueue = vi.hoisted(() => vi.fn());
vi.mock("../../api/endpoints/productionSend", () => ({
  fetchPrinterSendQueue,
  cancelPrinterSendQueueItem: vi.fn(),
  dispatchPrinterSendQueueItem: vi.fn(),
  drainPrinterSendQueue: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const queued: PrinterSendQueueItem = {
  id: "q1",
  filename: "plate.gcode",
  artifact_path: "/data/plate.gcode",
  printer_id: "printer-1",
  wait_for_idle: true,
  start: true,
  state: "queued",
  created_at: "2026-10-22T00:00:00Z",
  updated_at: "2026-10-22T00:00:00Z",
  host_name: "Core One",
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

function renderPanel(queryClient: QueryClient, profileId: number | null, engineReady = true) {
  const counts: number[] = [];
  render(
    <QueryClientProvider client={queryClient}>
      <PrinterSendQueuePanel
        profileId={profileId}
        engineReady={engineReady}
        onActiveCountChange={(count) => { counts.push(count); }}
      />
    </QueryClientProvider>,
  );
  return counts;
}

describe("PrinterSendQueuePanel farm visibility", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    fetchPrinterSendQueue.mockReset();
    fetchPrinterSendQueue.mockResolvedValue({ items: [queued] });
  });

  it("keeps the queue when feature toggles are not advertised", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    const counts = renderPanel(queryClient, 7);

    expect(await screen.findByRole("region", { name: "Printer send queue" })).toBeTruthy();
    expect(screen.getByText("plate.gcode")).toBeTruthy();
    expect(fetchPrinterSendQueue).toHaveBeenCalledWith({ active: true });
    await waitFor(() => expect(counts.at(-1)).toBe(1));
  });

  it("hides the queue and does not fetch it when the Plan's farm choice is off", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    const counts = renderPanel(queryClient, 7);

    await waitFor(() => expect(counts).toEqual([0]));
    expect(screen.queryByRole("region", { name: "Printer send queue" })).toBeNull();
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();
  });

  it("shows the queued file when the Plan's farm choice is on", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(true));
    const counts = renderPanel(queryClient, 7);

    expect(await screen.findByText("plate.gcode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send ready" })).toBeTruthy();
    expect(fetchPrinterSendQueue).toHaveBeenCalledWith({ active: true });
    await waitFor(() => expect(counts.at(-1)).toBe(1));
  });

  it("hides the queue while Plan features load and after they fail", async () => {
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
    const counts = renderPanel(queryClient, 7);

    await waitFor(() => expect(counts).toEqual([0]));
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    await act(async () => fail());
    await vi.waitFor(() => expect(queryClient.getQueryState(queryKeys.planFeatures(7))?.status).toBe("error"));
    expect(screen.queryByRole("region", { name: "Printer send queue" })).toBeNull();
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();
  });

  it("hides the queue for features that belong to another Plan", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(true, 8));
    renderPanel(queryClient, 7);

    await waitFor(() => expect(screen.queryByText("plate.gcode")).toBeNull());
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();
  });

  it("hides the queue as soon as the Plan's farm choice is revoked", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(true));
    const counts = renderPanel(queryClient, 7);
    expect(await screen.findByText("plate.gcode")).toBeTruthy();

    act(() => {
      queryClient.setQueryData(queryKeys.planFeatures(7), planFeatures(false));
    });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Printer send queue" })).toBeNull());
    await waitFor(() => expect(counts.at(-1)).toBe(0));
  });

  it("uses the account farm choice when no Plan is selected", async () => {
    const hidden = client();
    hidden.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    hidden.setQueryData(queryKeys.tenantFeatures, accountFeatures(false));
    const counts = renderPanel(hidden, null);
    await waitFor(() => expect(counts).toEqual([0]));
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();

    cleanup();
    fetchPrinterSendQueue.mockClear();
    const shown = client();
    shown.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    shown.setQueryData(queryKeys.tenantFeatures, accountFeatures(true));
    renderPanel(shown, null);
    expect(await screen.findByText("plate.gcode")).toBeTruthy();
    expect(fetchPrinterSendQueue).toHaveBeenCalledWith({ active: true });
  });

  it("does not fetch the queue before the engine is ready", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [] });
    const counts = renderPanel(queryClient, 7, false);

    await waitFor(() => expect(counts).toEqual([0]));
    expect(screen.queryByRole("region", { name: "Printer send queue" })).toBeNull();
    expect(fetchPrinterSendQueue).not.toHaveBeenCalled();
  });
});
