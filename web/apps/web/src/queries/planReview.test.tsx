// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { PlanReview } from "../api/engine";
import { queryKeys } from "./keys";
import {
  usePatchPartAssembledMutation,
  usePatchPartProgressMutation,
} from "./planReview";

const review: PlanReview = {
  profile_id: 1,
  accepted_basis: null,
  plan_name: "Test Plan",
  layers: [],
  totals: {
    included_parts: 1,
    total_print_units: 1,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [
    {
      folder: "parts",
      source_layer: "base:test",
      parts: [
        {
          id: 42,
          match_key: "cube.stl",
          relative_path: "parts/cube.stl",
          filename: "cube.stl",
          source_layer: "base:test",
          status: "ok",
          role: "primary",
          requirement: null,
          option_group_id: null,
          included: true,
          filament_color_id: null,
          quantity_auto: 1,
          quantity_override: null,
          quantity_effective: 1,
          printed_count: 0,
          print_units: [false],
          missing: true,
          filament_display: "Unset",
        },
      ],
    },
  ],
};

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    patchPartProgress: vi.fn().mockResolvedValue({
      printed_count: 1,
      print_units: [true],
      assembled_units: [],
      missing: false,
    }),
    patchPartAssembled: vi.fn().mockResolvedValue({
      assembled_count: 1,
      assembled_units: [true],
    }),
  };
});

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("Plan review mutations", () => {
  it("updates the active review and invalidates sibling review and Plan summaries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.planReview(1, false), review);
    queryClient.setQueryData(queryKeys.planReview(1, true), review);
    queryClient.setQueryData(queryKeys.profiles, []);
    const { result } = renderHook(() => usePatchPartProgressMutation(1, false), {
      wrapper: wrapper(queryClient),
    });

    await act(() =>
      result.current.mutateAsync({
        partId: 42,
        unitIndex: 0,
        completed: true,
        optimisticReview: review,
      }),
    );

    const current = queryClient.getQueryData<PlanReview>(
      queryKeys.planReview(1, false),
    );
    expect(current?.part_groups[0]?.parts[0]?.print_units).toEqual([true]);
    expect(queryClient.getQueryState(queryKeys.planReview(1, true))?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(true);
  });

  it("invalidates the active progress review when no optimistic review is supplied", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.planReview(1, false), review);
    const { result } = renderHook(() => usePatchPartProgressMutation(1, false), {
      wrapper: wrapper(queryClient),
    });

    await act(() =>
      result.current.mutateAsync({
        partId: 42,
        unitIndex: 0,
        completed: true,
      }),
    );

    expect(
      queryClient.getQueryState(queryKeys.planReview(1, false))?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates the active assembly review when no optimistic review is supplied", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.planReview(1, false), review);
    const { result } = renderHook(() => usePatchPartAssembledMutation(1, false), {
      wrapper: wrapper(queryClient),
    });

    await act(() =>
      result.current.mutateAsync({
        partId: 42,
        unitIndex: 0,
        assembled: true,
      }),
    );

    expect(
      queryClient.getQueryState(queryKeys.planReview(1, false))?.isInvalidated,
    ).toBe(true);
  });
});
