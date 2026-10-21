// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import BuildPlanningCard from "../components/build/BuildPlanningCard";
import PlanSpecialRequestLine from "../components/PlanSpecialRequestLine";
import { queryKeys } from "../queries/keys";

const fetchBuildPlanningState = vi.hoisted(() => vi.fn());
vi.mock("../api/endpoints/planManifests", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("../api/endpoints/planManifests")>()),
  fetchBuildPlanningState,
}));
vi.mock("../queries/buildWorkflow", () => ({ useBuildWorkflowQuery: () => ({ data: undefined }) }));

const request = "Ship to Alex, order #1042";
let client: QueryClient;
let featureResponse: () => Promise<Response>;

function features(orders: boolean, profileId = 7): PlanFeatures {
  return { profile_id: profileId, overrides: { orders }, effective: {
    farm: { enabled: false, source: "default" }, orders: { enabled: orders, source: "plan" },
    bambu: { enabled: false, source: "default" }, spoolman: { enabled: false, source: "default" },
  } };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function gate(plan?: PlanFeatures) {
  client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
  if (plan) client.setQueryData(queryKeys.planFeatures(7), plan);
}

function renderLine() {
  return render(
    <QueryClientProvider client={client}>
      <PlanSpecialRequestLine profileId={7} note={request} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  featureResponse = () => new Promise<Response>(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/plans/7/features") return featureResponse();
    return new Promise<Response>(() => {});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Checkoff customer request", () => {
  it("shows the request when the server does not advertise feature toggles", () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [] });
    renderLine();
    expect(screen.getByTestId("plan-special-request-line").textContent).toBe(request);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the request when Orders is enabled for the Plan", () => {
    gate(features(true));
    renderLine();
    expect(screen.getByTestId("plan-special-request-line").textContent).toBe(request);
  });

  it("hides the request when Orders is disabled for the Plan", () => {
    gate(features(false));
    renderLine();
    expect(screen.queryByTestId("plan-special-request-line")).toBeNull();
  });

  it("hides the request while Plan features load and after they fail", async () => {
    gate();
    let fail!: () => void;
    featureResponse = () => new Promise<Response>((_resolve, reject) => { fail = () => reject(new Error("boom")); });
    renderLine();
    expect(screen.queryByTestId("plan-special-request-line")).toBeNull();
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    await act(async () => fail());
    await vi.waitFor(() => expect(client.getQueryState(queryKeys.planFeatures(7))?.status).toBe("error"));
    expect(screen.queryByTestId("plan-special-request-line")).toBeNull();
  });

  it("loads Plan features and shows the request once Orders resolves enabled", async () => {
    gate();
    featureResponse = async () => json(features(true));
    renderLine();
    expect(await screen.findByTestId("plan-special-request-line")).toBeTruthy();
  });

  it("hides the request for features that belong to another Plan", () => {
    gate(features(true, 8));
    renderLine();
    expect(screen.queryByTestId("plan-special-request-line")).toBeNull();
  });

  it("hides the request as soon as Orders is revoked", async () => {
    gate(features(true));
    renderLine();
    expect(screen.getByTestId("plan-special-request-line")).toBeTruthy();
    act(() => { client.setQueryData(queryKeys.planFeatures(7), features(false)); });
    await vi.waitFor(() => expect(screen.queryByTestId("plan-special-request-line")).toBeNull());
  });
});

describe("Build planning brief", () => {
  beforeEach(() => {
    fetchBuildPlanningState.mockReset();
    fetchBuildPlanningState.mockResolvedValue({
      planning_phase: { kind: "preparing" },
      brief: { special_request: request, requirements: [], evidence: [], contributions: [], role_filaments: [] },
      readiness: { ready: true, blockers: [] },
      grouped_difference_count: 0,
      difference_count: 0,
    });
  });

  function renderCard() {
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter><BuildPlanningCard planId={7} /></MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("keeps the planning card but hides the customer request when Orders is disabled", async () => {
    gate(features(false));
    renderCard();
    expect(await screen.findByText("AI MCP Server changes")).toBeTruthy();
    expect(screen.queryByText(request)).toBeNull();
  });

  it("shows the customer request when Orders is enabled", async () => {
    gate(features(true));
    renderCard();
    expect(await screen.findByText(request)).toBeTruthy();
  });
});
