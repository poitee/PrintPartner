// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { patchPartAssembled, patchPartProgress } from "../api/endpoints/checkoff";
import { patchPart } from "../api/endpoints/plans";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "./keys";
import {
  usePatchPartAssembledMutation,
  usePatchPartMutation,
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

vi.mock("../api/endpoints/checkoff", () => ({
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
}));

vi.mock("../api/endpoints/plans", () => ({
  patchPart: vi.fn(),
}));

vi.mock("../api/endpoints/planManifests", () => ({
  fetchPlanReview: vi.fn(),
}));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("Plan review mutations", () => {
  it.each([true, false])("optimistically updates every copy and rolls back failed all-copies saves (%s)", async (completed) => {
    const multiple = structuredClone(review);
    const part = multiple.part_groups[0]!.parts[0]!;
    part.quantity_effective = 4;
    part.print_units = Array<boolean>(4).fill(!completed);
    part.printed_count = completed ? 0 : 4;
    part.assembled_units = Array<boolean>(4).fill(!completed);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const key = queryKeys.planReview(1, false);
    queryClient.setQueryData(key, multiple);
    let rejectSave: (error: Error) => void = () => {};
    vi.mocked(patchPartProgress).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const { result } = renderHook(() => usePatchPartProgressMutation(1, false), { wrapper: wrapper(queryClient) });
    act(() => result.current.mutate({ partId: 42, unitIndex: completed ? 3 : 0, completed, optimisticReview: multiple }));
    await waitFor(() => {
      const current = queryClient.getQueryData<PlanReview>(key)?.part_groups[0]?.parts[0];
      expect(current?.print_units).toEqual(Array(4).fill(completed));
      if (!completed) expect(current?.assembled_units).toEqual([false, false, false, false]);
    });
    act(() => rejectSave(new Error("Save failed")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(key)).toEqual(multiple);
  });
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

function pendingQuerySave<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  if (!resolve) throw new Error("Deferred mutation absent");
  return { promise, resolve };
}
afterEach(cleanup);
describe("Plan mutation Build ownership", () => {
  it.each((["progress", "assembly"] as const).flatMap((kind) =>
    [false, true].flatMap((includeExcluded) => [2, null].map((nextProfileId) => ({ kind, includeExcluded, nextProfileId }))),
  ))("preserves $kind ownership with excluded=$includeExcluded after switching to $nextProfileId", async ({ kind, includeExcluded, nextProfileId }) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.planReview(1, includeExcluded), review);
    queryClient.setQueryData(queryKeys.planReview(1, !includeExcluded), review);
    queryClient.setQueryData(queryKeys.planReview(2, !includeExcluded), { ...review, profile_id: 2 });
    const pending = pendingQuerySave<{ printed_count: number; print_units: boolean[]; assembled_count: number; assembled_units: boolean[]; missing: boolean }>();
    if (kind === "progress") vi.mocked(patchPartProgress).mockReturnValueOnce(pending.promise);
    else vi.mocked(patchPartAssembled).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ profileId }) => {
      const progress = usePatchPartProgressMutation(profileId, includeExcluded);
      const assembly = usePatchPartAssembledMutation(profileId, includeExcluded);
      return kind === "progress" ? progress : assembly;
    }, { initialProps: { profileId: 1 as number | null }, wrapper: wrapper(queryClient) });
    let save: Promise<unknown> | undefined;
    act(() => { save = hook.result.current.mutateAsync({ partId: 42, unitIndex: 0, completed: true, assembled: true, optimisticReview: review }); });
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    hook.rerender({ profileId: nextProfileId });
    await act(async () => { pending.resolve({ printed_count: 1, print_units: [true], assembled_count: 1, assembled_units: [true], missing: false }); await save; });
    expect(queryClient.getQueryState(queryKeys.planReview(1, !includeExcluded))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.planReview(2, !includeExcluded))?.isInvalidated).toBe(false);
    hook.unmount();
  });
  it.each([2, null])("invalidates the original part-edit Build after switching to %s", async (nextProfileId) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.planReview(1, false), review);
    queryClient.setQueryData(queryKeys.planReview(2, false), { ...review, profile_id: 2 });
    const pending = pendingQuerySave<Awaited<ReturnType<typeof patchPart>>>();
    vi.mocked(patchPart).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ profileId }) => usePatchPartMutation(profileId), { initialProps: { profileId: 1 as number | null }, wrapper: wrapper(queryClient) });
    let save: Promise<unknown> | undefined;
    act(() => { save = hook.result.current.mutateAsync({ partId: 42, body: { spoolman_spool_id: "4" } }); });
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    hook.rerender({ profileId: nextProfileId });
    await act(async () => { pending.resolve({ ...review.part_groups[0]!.parts[0]! }); await save; });
    expect(queryClient.getQueryState(queryKeys.planReview(1, false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.planReview(2, false))?.isInvalidated).toBe(false);
  });
});
