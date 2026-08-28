// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultProductionSetup, type ProductionSetup } from "@print-partner/contracts";
import { fetchProductionSetup, saveProductionSetup } from "../api/endpoints/productionSetup";
import { productionSetupKey, useProductionSetup } from "./productionSetup";

const stored: ProductionSetup = {
  ...defaultProductionSetup(1),
  preferred_slicer_instance_id: "orca-1",
  selection: { mode: "custom", selected_unit_tokens: ["unit-a", "unit-b"] },
  printer_assignments: [{ token: "unit-a", printer_id: "printer-1" }],
  route: "plates",
  rules: [{ id: "r1", enabled: true, kind: "separate_by", field: "color" }],
};

vi.mock("../api/endpoints/productionSetup", () => ({
  fetchProductionSetup: vi.fn(async () => stored),
  saveProductionSetup: vi.fn(async (_profileId: number, input: unknown) => ({
    ...stored,
    ...(input as object),
  })),
}));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function mount(profileId: number | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useProductionSetup(profileId), {
    wrapper: wrapper(queryClient),
  });
  return { queryClient, result };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useProductionSetup", () => {
  it("merges a one-field patch over the stored record", async () => {
    const { result } = mount(1);
    await waitFor(() => expect(result.current.data).toEqual(stored));

    await result.current.save({ route: "stl" });

    expect(saveProductionSetup).toHaveBeenCalledWith(1, {
      preferred_slicer_instance_id: "orca-1",
      selection: { mode: "custom", selected_unit_tokens: ["unit-a", "unit-b"] },
      printer_assignments: [{ token: "unit-a", printer_id: "printer-1" }],
      route: "stl",
      rules: stored.rules,
    });
  });

  it("puts the saved record straight into the cache", async () => {
    const { queryClient, result } = mount(1);
    await waitFor(() => expect(result.current.data).toEqual(stored));

    await result.current.save({ route: "external" });

    expect(queryClient.getQueryData<ProductionSetup>(productionSetupKey(1))?.route).toBe(
      "external",
    );
  });

  it("refuses to save before the record has loaded, rather than blanking it", async () => {
    const { result } = mount(null);
    await expect(result.current.save({ route: "stl" })).rejects.toThrow(
      "Production setup has not loaded yet.",
    );
    expect(saveProductionSetup).not.toHaveBeenCalled();
    expect(fetchProductionSetup).not.toHaveBeenCalled();
  });
});
