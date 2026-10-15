// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  featureKeys,
  type PlanFeatures,
} from "@print-partner/contracts";
import { queryKeys } from "../../queries/keys";
import PlanFeaturesCard from "./PlanFeaturesCard";

const state = vi.hoisted(() => ({
  capabilities: [] as string[],
  engineReady: true,
  planFeaturesById: {} as Record<number, PlanFeatures>,
  fetchCalls: [] as number[],
  patchCalls: [] as Array<{ profileId: number; patch: Record<string, boolean | null> }>,
  fetchError: null as Error | null,
  patchError: null as Error | null,
}));

vi.mock("../../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({
    health: { ok: state.engineReady, capabilities: state.capabilities },
    error: null,
    loading: false,
    fetching: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../api/endpoints/planFeatures", () => ({
  fetchPlanFeatures: vi.fn().mockImplementation(async (profileId: number) => {
    state.fetchCalls.push(profileId);
    if (state.fetchError) throw state.fetchError;
    const current = state.planFeaturesById[profileId] ?? {
      profile_id: profileId,
      overrides: {},
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };
    return current;
  }),
  patchPlanFeatures: vi.fn().mockImplementation(async (profileId: number, patch: Record<string, boolean | null>) => {
    state.patchCalls.push({ profileId, patch });
    if (state.patchError) throw state.patchError;
    const current = state.planFeaturesById[profileId] ?? {
      profile_id: profileId,
      overrides: {},
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };
    const nextOverrides = { ...current.overrides };
    const nextEffective = { ...current.effective };

    for (const key of featureKeys) {
      const value = patch[key];
      if (value === null) {
        delete nextOverrides[key];
        nextEffective[key] = {
          enabled: false,
          source: "default",
        };
      } else if (value !== undefined) {
        nextOverrides[key] = value;
        nextEffective[key] = {
          enabled: value,
          source: "plan",
        };
      }
    }

    const updated: PlanFeatures = {
      profile_id: profileId,
      overrides: nextOverrides,
      effective: nextEffective,
    };
    state.planFeaturesById[profileId] = updated;
    return updated;
  }),
}));

function renderCard(
  props: { profileId: number; disabled?: boolean } = { profileId: 1 },
  customQueryClient?: QueryClient,
) {
  const queryClient = customQueryClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <PlanFeaturesCard {...props} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("PlanFeaturesCard", () => {
  beforeEach(() => {
    state.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    state.engineReady = true;
    state.fetchCalls = [];
    state.patchCalls = [];
    state.fetchError = null;
    state.patchError = null;
    state.planFeaturesById = {
      1: {
        profile_id: 1,
        overrides: {},
        effective: {
          farm: { enabled: false, source: "default" },
          orders: { enabled: false, source: "default" },
          bambu: { enabled: false, source: "default" },
          spoolman: { enabled: false, source: "default" },
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("capability off hides controls and makes no feature requests", () => {
    state.capabilities = [];
    renderCard({ profileId: 1 });

    expect(screen.queryByText(/plan feature toggles/i)).toBeNull();
    expect(screen.queryByText(/print farm/i)).toBeNull();
    expect(state.fetchCalls).toEqual([]);
  });

  it("capability on renders inherited defaults off with all four features", async () => {
    state.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    renderCard({ profileId: 1 });

    expect(await screen.findByText(/plan feature toggles/i)).toBeTruthy();
    expect(await screen.findByText("Print farm")).toBeTruthy();
    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.getByText("Bambu printers")).toBeTruthy();
    expect(screen.getByText("Spoolman")).toBeTruthy();

    const farmInherit = screen.getByRole("button", { name: "Print farm: Inherit" });
    expect(farmInherit.getAttribute("aria-pressed")).toBe("true");

    const farmEffective = screen.getByTestId("effective-farm");
    expect(farmEffective.textContent).toContain("Off");
    expect(farmEffective.textContent).toContain("Default");
  });

  it("sends explicit on and off choices and displays the server response", async () => {
    renderCard({ profileId: 1 });

    const bambuOn = await screen.findByRole("button", { name: "Bambu printers: On" });
    fireEvent.click(bambuOn);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ profileId: 1, patch: { bambu: true } });
    });

    const bambuEffective = screen.getByTestId("effective-bambu");
    expect(bambuEffective.textContent).toContain("On");
    expect(bambuEffective.textContent).toContain("Plan override");

    const spoolmanOff = screen.getByRole("button", { name: "Spoolman: Off" });
    fireEvent.click(spoolmanOff);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ profileId: 1, patch: { spoolman: false } });
    });

    const spoolmanEffective = screen.getByTestId("effective-spoolman");
    expect(spoolmanEffective.textContent).toContain("Off");
    expect(spoolmanEffective.textContent).toContain("Plan override");
  });

  it("resets null and shows inherited enabled tenant default", async () => {
    state.planFeaturesById[1] = {
      profile_id: 1,
      overrides: { farm: true },
      effective: {
        farm: { enabled: true, source: "plan" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };

    vi.mocked((await import("../../api/endpoints/planFeatures")).patchPlanFeatures).mockImplementationOnce(
      async (profileId: number, patch: Record<string, boolean | null>) => {
        state.patchCalls.push({ profileId, patch });
        const updated: PlanFeatures = {
          profile_id: profileId,
          overrides: {},
          effective: {
            farm: { enabled: true, source: "user" },
            orders: { enabled: false, source: "default" },
            bambu: { enabled: false, source: "default" },
            spoolman: { enabled: false, source: "default" },
          },
        };
        state.planFeaturesById[profileId] = updated;
        return updated;
      },
    );

    renderCard({ profileId: 1 });

    const farmOn = await screen.findByRole("button", { name: "Print farm: On" });
    expect(farmOn.getAttribute("aria-pressed")).toBe("true");

    const farmInherit = screen.getByRole("button", { name: "Print farm: Inherit" });
    fireEvent.click(farmInherit);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ profileId: 1, patch: { farm: null } });
    });

    const farmEffective = await screen.findByTestId("effective-farm");
    expect(farmEffective.textContent).toContain("On");
    expect(farmEffective.textContent).toContain("Account setting");
  });

  it("shows a load error without editable choices", async () => {
    state.fetchError = new Error("Feature settings unavailable");
    renderCard();
    expect((await screen.findByRole("alert")).textContent).toContain("Feature settings unavailable");
    expect(screen.queryByRole("button", { name: "Print farm: On" })).toBeNull();
  });

  it("disables cached choices when the engine is unavailable", async () => {
    const { rerender, queryClient } = renderCard();
    await screen.findByRole("button", { name: "Print farm: On" });
    state.engineReady = false;
    rerender(<QueryClientProvider client={queryClient}><PlanFeaturesCard profileId={1} /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "Print farm: On" })).toHaveProperty("disabled", true);
  });

  it("shows a save error and retains the saved choice", async () => {
    state.patchError = new Error("Conflict or network failure");
    renderCard({ profileId: 1 });

    const ordersOn = await screen.findByRole("button", { name: "Orders: On" });
    fireEvent.click(ordersOn);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Conflict or network failure");

    expect(ordersOn.getAttribute("aria-pressed")).toBe("false");
    const ordersInherit = screen.getByRole("button", { name: "Orders: Inherit" });
    expect(ordersInherit.getAttribute("aria-pressed")).toBe("true");
  });

  it("handles plan isolation and switching sharing the SAME QueryClient", async () => {
    state.planFeaturesById[1] = {
      profile_id: 1,
      overrides: { farm: true },
      effective: {
        farm: { enabled: true, source: "plan" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };
    state.planFeaturesById[2] = {
      profile_id: 2,
      overrides: { orders: true },
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: true, source: "plan" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = renderCard({ profileId: 1 }, queryClient);

    const farmOn = await screen.findByRole("button", { name: "Print farm: On" });
    expect(farmOn.getAttribute("aria-pressed")).toBe("true");

    rerender(
      <QueryClientProvider client={queryClient}>
        <PlanFeaturesCard profileId={2} />
      </QueryClientProvider>,
    );

    const ordersOn = await screen.findByRole("button", { name: "Orders: On" });
    expect(ordersOn.getAttribute("aria-pressed")).toBe("true");

    const bambuOn = screen.getByRole("button", { name: "Bambu printers: On" });
    fireEvent.click(bambuOn);

    await waitFor(() => {
      expect(state.patchCalls).toContainEqual({ profileId: 2, patch: { bambu: true } });
    });
    expect(state.patchCalls.filter((c) => c.profileId === 1)).toEqual([]);
  });

  it("keeps an in-flight save in its original Plan cache after switching Plans", async () => {
    state.planFeaturesById[1] = {
      profile_id: 1,
      overrides: { farm: true },
      effective: {
        farm: { enabled: true, source: "plan" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };
    state.planFeaturesById[2] = {
      profile_id: 2,
      overrides: { orders: true },
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: true, source: "plan" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: false, source: "default" },
      },
    };

    let resolvePatchPlan1: ((val: PlanFeatures) => void) | undefined;
    const planFeaturesApi = await import("../../api/endpoints/planFeatures");
    vi.mocked(planFeaturesApi.patchPlanFeatures).mockImplementationOnce(
      () =>
        new Promise<PlanFeatures>((resolve) => {
          resolvePatchPlan1 = resolve;
        }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = renderCard({ profileId: 1 }, queryClient);

    const farmOn = await screen.findByRole("button", { name: "Print farm: On" });
    expect(farmOn.getAttribute("aria-pressed")).toBe("true");

    const bambuOn = screen.getByRole("button", { name: "Bambu printers: On" });
    fireEvent.click(bambuOn);

    await waitFor(() => expect(bambuOn).toHaveProperty("disabled", true));
    expect(bambuOn.getAttribute("aria-pressed")).toBe("false");

    rerender(
      <QueryClientProvider client={queryClient}>
        <PlanFeaturesCard profileId={2} />
      </QueryClientProvider>,
    );

    const ordersOn = await screen.findByRole("button", { name: "Orders: On" });
    expect(ordersOn.getAttribute("aria-pressed")).toBe("true");

    const plan1Updated: PlanFeatures = {
      profile_id: 1,
      overrides: { farm: true, bambu: true },
      effective: {
        farm: { enabled: true, source: "plan" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: true, source: "plan" },
        spoolman: { enabled: false, source: "default" },
      },
    };
    resolvePatchPlan1?.(plan1Updated);

    await waitFor(() => {
      const cachedPlan1 = queryClient.getQueryData<PlanFeatures>(queryKeys.planFeatures(1));
      expect(cachedPlan1?.overrides.bambu).toBe(true);
      const cachedPlan2 = queryClient.getQueryData<PlanFeatures>(queryKeys.planFeatures(2));
      expect(cachedPlan2?.overrides.orders).toBe(true);
      expect(cachedPlan2?.overrides.bambu).toBeUndefined();
    });

    expect(ordersOn.getAttribute("aria-pressed")).toBe("true");
  });
});
