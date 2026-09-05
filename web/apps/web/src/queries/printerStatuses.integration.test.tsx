// @vitest-environment jsdom

import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PrinterLiveStrip from "../components/checkoff/PrinterLiveStrip";
import PrintersPage from "../pages/PrintersPage";
import { printerStatusKey, usePrinterStatuses } from "./printerStatuses";

const api = vi.hoisted(() => ({
  fetchIntegrationStatus: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchPrinterCheckoffLinks: vi.fn(),
  fetchPrinters: vi.fn(),
  reconcilePrinterCheckoff: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));

vi.mock("../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => 60_000,
}));

vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: null }),
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
  reconcilePrinterCheckoff: api.reconcilePrinterCheckoff,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchPrinters.mockResolvedValue([
    {
      id: "printer-1",
      name: "X1 Carbon",
      model: "x1-carbon",
      integration_id: "bambu-1",
      enabled: true,
    },
  ]);
  api.fetchIntegrations.mockResolvedValue([
    {
      id: "bambu-1",
      name: "X1 Carbon",
      type: "bambu",
      config: { enabled: true },
    },
  ]);
  api.fetchPrinterCheckoffLinks.mockResolvedValue({ links: [] });
  api.fetchIntegrationStatus.mockReturnValue(new Promise(() => undefined));
});

describe("shared printer status polling", () => {
  it("makes one in-flight status request when two screens observe the same host", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PrintersPage />
          <PrinterLiveStrip engineReady />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);
    });
  });

  it("does not start another poll while a host request is still running", async () => {
    vi.useFakeTimers();
    api.fetchIntegrationStatus
      .mockResolvedValueOnce({ state: "idle" })
      .mockReturnValueOnce(new Promise(() => undefined));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="first" />
        <StatusConsumer integrationIds={["bambu-1"]} label="second" />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("first").textContent).toBe("idle");
      expect(screen.getByTestId("second").textContent).toBe("idle");
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(2);

    const activeRequest = queryClient.getQueryCache().find({
      queryKey: printerStatusKey("bambu-1"),
      exact: true,
    })?.promise;
    if (!activeRequest) throw new Error("Expected a running printer status query.");
    expect(vi.getTimerCount()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(2);
  });

  it("gives a later consumer the cached host status without another request", async () => {
    api.fetchIntegrationStatus.mockResolvedValue({ state: "idle" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="first" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("first").textContent).toBe("idle");
    });

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="first" />
        <StatusConsumer integrationIds={["bambu-1"]} label="later" />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("later").textContent).toBe("idle");
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);
  });

  it("polls a cached host at the configured interval after a new observer mounts", async () => {
    vi.useFakeTimers();
    api.fetchIntegrationStatus.mockResolvedValue({ state: "idle" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstView = render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="first" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId("first").textContent).toBe("idle");
    });
    firstView.unmount();

    await act(() => vi.advanceTimersByTimeAsync(50_000));
    render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="later" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("later").textContent).toBe("idle");
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(59_999));
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps healthy hosts visible when another host is offline", async () => {
    api.fetchIntegrationStatus.mockImplementation(async (integrationId: string) => {
      if (integrationId === "offline-1") throw new Error("connection refused");
      return { state: "printing", filename: "bracket.gcode" };
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer
          integrationIds={["healthy-1", "offline-1"]}
          label="fleet"
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("fleet").textContent).toBe("printing,offline");
    });
  });

  it("pauses status polling while the document is in the background", async () => {
    vi.useFakeTimers();
    api.fetchIntegrationStatus.mockResolvedValue({ state: "idle" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatusConsumer integrationIds={["bambu-1"]} label="host" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);
    });

    focusManager.setFocused(false);
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await vi.waitFor(() => {
      expect(api.fetchIntegrationStatus).toHaveBeenCalledTimes(2);
    });
  });
});

function StatusConsumer({
  integrationIds,
  label,
}: Readonly<{ integrationIds: readonly string[]; label: string }>) {
  const { statusByIntegration } = usePrinterStatuses(integrationIds);
  return (
    <output data-testid={label}>
      {integrationIds
        .map((integrationId) => statusByIntegration[integrationId]?.state ?? "loading")
        .join(",")}
    </output>
  );
}
