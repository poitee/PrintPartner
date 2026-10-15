// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FeatureSettings } from "@print-partner/contracts";
import TenantFeaturesSettingsCard from "./TenantFeaturesSettingsCard";

const state = vi.hoisted((): { featureSettings: FeatureSettings; patchCalls: unknown[]; fetchError: Error | null; patchError: Error | null } => ({
  featureSettings: {
    choices: {},
    effective: {
      farm: { enabled: false, source: "default" },
      orders: { enabled: false, source: "default" },
      bambu: { enabled: false, source: "default" },
      spoolman: { enabled: false, source: "default" },
    },
  },
  patchCalls: [],
  fetchError: null,
  patchError: null,
}));

vi.mock("../../api/endpoints/tenantFeatures", () => ({
  fetchTenantFeatures: vi.fn().mockImplementation(async () => {
    if (state.fetchError) throw state.fetchError;
    return state.featureSettings;
  }),
  patchTenantFeatures: vi.fn().mockImplementation(async (patch) => {
    state.patchCalls.push(patch);
    if (state.patchError) throw state.patchError;
    const nextChoices = { ...state.featureSettings.choices, ...patch };
    state.featureSettings = {
      choices: nextChoices,
      effective: {
        farm: { enabled: nextChoices.farm ?? false, source: nextChoices.farm ? "user" : "default" },
        orders: { enabled: nextChoices.orders ?? false, source: nextChoices.orders ? "user" : "default" },
        bambu: { enabled: nextChoices.bambu ?? false, source: nextChoices.bambu ? "user" : "default" },
        spoolman: { enabled: nextChoices.spoolman ?? false, source: nextChoices.spoolman ? "user" : "default" },
      },
    };
    return state.featureSettings;
  }),
}));

function renderCard(props: { engineReady?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TenantFeaturesSettingsCard {...props} />
    </QueryClientProvider>,
  );
}

describe("TenantFeaturesSettingsCard", () => {
  beforeEach(() => {
    state.fetchError = null;
    state.patchError = null;
    state.patchCalls = [];
    state.featureSettings = {
      choices: {},
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders all four features with switches defaulting to off", async () => {
    renderCard();

    expect(await screen.findByText("Feature toggles")).toBeTruthy();
    expect(await screen.findByText("Print farm")).toBeTruthy();
    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.getByText("Bambu printers")).toBeTruthy();
    expect(screen.getByText("Spoolman")).toBeTruthy();

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const sw of switches) {
      expect(sw.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("does not fetch or render switches when engine is not ready", async () => {
    renderCard({ engineReady: false });

    expect(await screen.findByText("Feature toggles")).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(state.patchCalls).toEqual([]);
  });

  it("dispatches patch when toggle is clicked and updates switch state", async () => {
    renderCard();

    const bambuSwitch = await screen.findByLabelText(/Bambu printers/i);
    expect(bambuSwitch.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(bambuSwitch);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ bambu: true });
      expect(bambuSwitch.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("disables an enabled feature", async () => {
    state.featureSettings = {
      choices: { spoolman: true },
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: true, source: "user" },
      },
    };

    renderCard();

    const spoolmanSwitch = await screen.findByLabelText(/Spoolman/i);
    expect(spoolmanSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(spoolmanSwitch);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ spoolman: false });
      expect(spoolmanSwitch.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("displays save error alert when mutation fails", async () => {
    renderCard();

    const ordersSwitch = await screen.findByLabelText(/Orders/i);
    state.patchError = new Error("Failed to persist toggle");

    fireEvent.click(ordersSwitch);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to save feature toggle: Failed to persist toggle");
  });
});
