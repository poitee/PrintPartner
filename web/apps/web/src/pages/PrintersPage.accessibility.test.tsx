// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
    render(
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

    render(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load printers: database unavailable",
    );
  });

  it("announces printer roster loading after the engine connects", () => {
    state.health = { ok: true };
    state.healthLoading = false;
    api.fetchPrinters.mockReturnValue(new Promise(() => undefined));
    api.fetchIntegrations.mockReturnValue(new Promise(() => undefined));
    api.fetchPrinterCheckoffLinks.mockReturnValue(new Promise(() => undefined));

    render(
      <MemoryRouter>
        <PrintersPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toContain("Loading printers");
    expect(screen.queryByText("No linked printers")).toBeNull();
  });
});
