// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => 60_000,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

describe("PrinterLiveStrip", () => {
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

    renderWithQueryClient(
      <MemoryRouter>
        <PrinterLiveStrip
          engineReady
          onUnattributedUpdate={onUnattributedUpdate}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Printing bracket.bgcode")).toBeTruthy();
    expect(api.fetchIntegrationStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onUnattributedUpdate).toHaveBeenCalledOnce();
    });
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
      expect(onUnattributedUpdate).toHaveBeenCalledOnce();
    });
  });

  it("emits one global refresh hint after parallel per-printer reconcile results", async () => {
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

    renderWithQueryClient(
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
  });
});
