// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PrintersPage from "./PrintersPage";

const state = vi.hoisted(() => ({
  health: null as { ok: true } | null,
  healthLoading: true,
}));

const api = vi.hoisted(() => ({
  fetchPrinters: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchPrinterCheckoffLinks: vi.fn(),
  fetchIntegrationStatus: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: state.health, error: null, loading: state.healthLoading }),
}));
vi.mock("../hooks/usePrinterStatusPollMs", () => ({
  usePrinterStatusPollMs: () => 30_000,
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [] }),
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

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

describe("PrintersPage accessibility", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.health = null;
    state.healthLoading = true;
    api.fetchPrinters.mockReset();
    api.fetchIntegrations.mockReset();
    api.fetchPrinterCheckoffLinks.mockReset();
    api.fetchIntegrationStatus.mockReset();
  });

  it("announces the connecting state", () => {
    renderWithQueryClient(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toContain("Connecting to the engine");
  });

  it("announces a printer roster load error", async () => {
    state.health = { ok: true };
    state.healthLoading = false;
    api.fetchPrinters.mockRejectedValue(new Error("database unavailable"));
    api.fetchIntegrations.mockResolvedValue([]);
    api.fetchPrinterCheckoffLinks.mockResolvedValue({ links: [] });

    renderWithQueryClient(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load printers: database unavailable",
    );
    expect(screen.queryByText("No printers")).toBeNull();

    api.fetchPrinters.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No printers")).toBeTruthy();
  });

  it("announces printer roster loading after the engine connects", () => {
    state.health = { ok: true };
    state.healthLoading = false;
    api.fetchPrinters.mockReturnValue(new Promise(() => undefined));
    api.fetchIntegrations.mockReturnValue(new Promise(() => undefined));
    api.fetchPrinterCheckoffLinks.mockReturnValue(new Promise(() => undefined));

    renderWithQueryClient(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toContain("Loading printers");
    expect(screen.queryByText("No linked printers")).toBeNull();
  });

  it("does not label a live job unbound while checkoff links are still loading", async () => {
    state.health = { ok: true };
    state.healthLoading = false;
    api.fetchPrinters.mockResolvedValue([
      {
        id: "printer-1",
        name: "Core One",
        model: "core-one",
        integration_id: "prusa-1",
        enabled: true,
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
    api.fetchIntegrationStatus.mockResolvedValue({
      state: "printing",
      filename: "bracket.bgcode",
    });
    api.fetchPrinterCheckoffLinks.mockReturnValue(new Promise(() => undefined));

    renderWithQueryClient(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(screen.queryByText("No plan.")).toBeNull();
  });
});
