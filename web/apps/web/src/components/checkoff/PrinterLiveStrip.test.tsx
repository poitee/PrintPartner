// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PrinterLiveStrip from "./PrinterLiveStrip";

const api = vi.hoisted(() => ({
  fetchPrinters: vi.fn(),
  fetchIntegrations: vi.fn(),
  reconcilePrinterCheckoff: vi.fn(),
  fetchIntegrationStatus: vi.fn(),
}));

vi.mock("../../api/endpoints/printers", () => ({
  fetchPrinters: api.fetchPrinters,
}));
vi.mock("../../api/endpoints/integrations", () => ({
  fetchIntegrations: api.fetchIntegrations,
  fetchIntegrationStatus: api.fetchIntegrationStatus,
}));
vi.mock("../../api/endpoints/checkoff", () => ({
  reconcilePrinterCheckoff: api.reconcilePrinterCheckoff,
}));
const statusPoll = vi.hoisted(() => ({ ms: 60_000 }));

vi.mock("../../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => statusPoll.ms,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  statusPoll.ms = 60_000;
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("PrinterLiveStrip", () => {
  it("does not request connection settings or printer status for manual printers", async () => {
    api.fetchPrinters.mockResolvedValue([{ id: "manual", name: "Manual printer", integration_id: null }]);
    api.fetchIntegrations.mockRejectedValue(new Error("Authentication required"));
    renderWithQueryClient(<MemoryRouter><PrinterLiveStrip engineReady /></MemoryRouter>);
    await waitFor(() => expect(api.fetchPrinters).toHaveBeenCalledTimes(1));
    expect(api.fetchIntegrations).not.toHaveBeenCalled();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
    expect(api.reconcilePrinterCheckoff).not.toHaveBeenCalled();
    expect(screen.queryByText(/Authentication required/)).toBeNull();
  });

  it("does not overlap reconcile polls for one printer", async () => {
    vi.useFakeTimers();
    api.fetchPrinters.mockResolvedValue([
      {
        id: "core-one",
        name: "Core One",
        integration_id: "prusa-1",
      },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      {
        id: "prusa-1",
        name: "Core One",
        type: "prusalink",
        config: { enabled: true },
      },
    ]);
    api.reconcilePrinterCheckoff.mockReturnValue(new Promise(() => {}));
    api.fetchIntegrationStatus.mockResolvedValue({ state: "idle" });

    renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip engineReady />
      </MemoryRouter>,
    );

    await vi.waitFor(() => {
      expect(api.reconcilePrinterCheckoff).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(180_000);

    expect(api.reconcilePrinterCheckoff).toHaveBeenCalledTimes(1);
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
  });

  it("shows a healthy reconciled host while another host poll is still running", async () => {
    api.fetchPrinters.mockResolvedValue([
      {
        id: "printer-a",
        name: "Printer A",
        integration_id: "prusa-a",
      },
      {
        id: "printer-b",
        name: "Printer B",
        integration_id: "prusa-b",
      },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      {
        id: "prusa-a",
        name: "Printer A",
        type: "prusalink",
        config: { enabled: true },
      },
      {
        id: "prusa-b",
        name: "Printer B",
        type: "prusalink",
        config: { enabled: true },
      },
    ]);
    api.reconcilePrinterCheckoff.mockImplementation(
      ({ integration_id }: { integration_id: string }) => {
        if (integration_id === "prusa-a") return new Promise(() => undefined);
        return Promise.resolve({
          status: { state: "printing", filename: "bracket.bgcode" },
          updates: [],
          created_links: [],
          unattributed: [],
        });
      },
    );
    const onUnattributedUpdate = vi.fn();

    const view = renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip
          engineReady
          onUnattributedUpdate={onUnattributedUpdate}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Printing bracket.bgcode")).toBeTruthy();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
    expect(onUnattributedUpdate).not.toHaveBeenCalled();
    await act(async () => { await view.queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("prusa-b") }); });
    expect(onUnattributedUpdate).not.toHaveBeenCalled();
  });

  it("notifies Progress when reconcile discovers a currently printing link", async () => {
    api.fetchPrinters.mockResolvedValue([
      {
        id: "core-one",
        name: "Core One",
        integration_id: "prusa-1",
      },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      {
        id: "prusa-1",
        name: "Core One",
        type: "prusalink",
        config: { enabled: true },
      },
    ]);
    api.reconcilePrinterCheckoff.mockResolvedValue({
      status: {
        state: "printing",
        filename: "bracket.bgcode",
        progress: 42,
      },
      updates: [],
      unattributed: [],
      created_links: [
        {
          id: "link-1",
          profile_id: 7,
          integration_id: "prusa-1",
          printer_id: "core-one",
          host_name: "Core One",
          filename: "bracket.bgcode",
          units: [{ part_id: 9, unit_index: 0 }],
          state: "watching",
          saw_active: true,
          created_at: new Date().toISOString(),
        },
      ],
    });
    api.fetchIntegrationStatus.mockResolvedValue({ state: "printing" });
    const onCheckoffUpdate = vi.fn();
    const onUnattributedUpdate = vi.fn();

    renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip
          engineReady
          onCheckoffUpdate={onCheckoffUpdate}
          onUnattributedUpdate={onUnattributedUpdate}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(api.reconcilePrinterCheckoff).toHaveBeenCalledWith({
        integration_id: "prusa-1",
      });
      expect(onCheckoffUpdate).toHaveBeenCalledWith(7);
      expect(onUnattributedUpdate).not.toHaveBeenCalled();
    });
  });

  it("backs off reconcile polls for an unreachable host up to a minute and resumes after it answers", async () => {
    vi.useFakeTimers();
    statusPoll.ms = 5_000;
    api.fetchPrinters.mockResolvedValue([
      { id: "core-one", name: "Core One", integration_id: "prusa-1" },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      { id: "prusa-1", name: "Core One", type: "prusalink", config: { enabled: true } },
    ]);
    const refused = new Error("connect ECONNREFUSED");
    api.reconcilePrinterCheckoff
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValue({ status: { state: "idle" }, updates: [], created_links: [], unattributed: [] });
    const reconciles = () => api.reconcilePrinterCheckoff.mock.calls.length;

    renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip engineReady />
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(reconciles()).toBe(1));

    for (const [waitMs, expected] of [
      [9_000, 1], [1_000, 2],
      [19_000, 2], [1_000, 3],
      [39_000, 3], [1_000, 4],
      [59_000, 4], [1_000, 5],
      [5_000, 6],
    ] as const) {
      await act(() => vi.advanceTimersByTimeAsync(waitMs));
      expect(reconciles()).toBe(expected);
    }
  });

  it("notifies each affected Build once per reconcile", async () => {
    api.fetchPrinters.mockResolvedValue([
      { id: "core-one", name: "Core One", integration_id: "prusa-1" },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      { id: "prusa-1", name: "Core One", type: "prusalink", config: { enabled: true } },
    ]);
    const update = (linkId: string, profileId: number) => ({
      link_id: linkId,
      profile_id: profileId,
      event: "awaiting_verify",
      host_name: "Core One",
      host_outcome: "complete",
      filename: `${linkId}.bgcode`,
    });
    const created = (linkId: string, profileId: number) => ({
      id: linkId,
      profile_id: profileId,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: `${linkId}.bgcode`,
      units: [{ part_id: 9, unit_index: 0 }],
      state: "watching",
      saw_active: true,
      created_at: new Date().toISOString(),
    });
    api.reconcilePrinterCheckoff.mockResolvedValue({
      status: { state: "idle" },
      updates: [update("link-1", 7), update("link-2", 7), update("link-3", 8)],
      created_links: [created("link-4", 7), created("link-5", 8)],
      unattributed: [],
    });
    const onCheckoffUpdate = vi.fn();

    renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip engineReady onCheckoffUpdate={onCheckoffUpdate} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(onCheckoffUpdate).toHaveBeenCalledTimes(2));
    expect(onCheckoffUpdate).toHaveBeenNthCalledWith(1, 7);
    expect(onCheckoffUpdate).toHaveBeenNthCalledWith(2, 8);
  });

  it("refreshes changed unattributed lists but not repeated identical polls", async () => {
    api.fetchPrinters.mockResolvedValue([
      {
        id: "printer-a",
        name: "Printer A",
        integration_id: "prusa-a",
      },
      {
        id: "printer-b",
        name: "Printer B",
        integration_id: "prusa-b",
      },
    ]);
    api.fetchIntegrations.mockResolvedValue([
      {
        id: "prusa-a",
        name: "Printer A",
        type: "prusalink",
        config: { enabled: true },
      },
      {
        id: "prusa-b",
        name: "Printer B",
        type: "prusalink",
        config: { enabled: true },
      },
    ]);
    api.reconcilePrinterCheckoff.mockImplementation(
      async ({ integration_id }: { integration_id: string }) => ({
        status: { state: "idle" },
        updates: [],
        created_links: [],
        unattributed: integration_id === "prusa-a" ? [{ id: "print-a" }] : [],
      }),
    );
    api.fetchIntegrationStatus.mockResolvedValue({ state: "idle" });
    const onUnattributedUpdate = vi.fn();

    const view = renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip
          engineReady
          onUnattributedUpdate={onUnattributedUpdate}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(api.reconcilePrinterCheckoff).toHaveBeenCalledTimes(2);
      expect(onUnattributedUpdate).toHaveBeenCalledTimes(1);
      expect(onUnattributedUpdate).toHaveBeenCalledWith();
    });
    await act(async () => { await view.queryClient.invalidateQueries(); });
    expect(onUnattributedUpdate).toHaveBeenCalledTimes(1);
    api.reconcilePrinterCheckoff.mockResolvedValue({
      status: { state: "idle" }, updates: [], created_links: [], unattributed: [],
    });
    await act(async () => { await view.queryClient.invalidateQueries(); });
    await waitFor(() => expect(onUnattributedUpdate).toHaveBeenCalledTimes(2));
  });
});
