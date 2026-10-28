// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import { patchPartAssembled, patchPartProgress } from "../api/endpoints/checkoff";
import { fetchPlanReview, type PlanReview } from "../api/endpoints/planManifests";
import { patchPart } from "../api/endpoints/plans";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { queryKeys } from "./keys";
import {
  usePatchPartAssembledMutation,
  usePatchPartMutation,
  usePatchPartProgressMutation,
  usePlanReviewQuery,
} from "./planReview";

const healthState = vi.hoisted(() => ({ capabilities: [] as string[] }));

vi.mock("./health", () => ({
  useHealthQuery: () => ({
    data: { ok: true, capabilities: healthState.capabilities },
    status: "success" as const,
    isSuccess: true,
  }),
}));

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

function reviewFor(revisionId: number): PlanReview {
  return {
    ...review,
    profile_id: 7,
    accepted_basis: {
      profile_id: 7,
      plan_revision_id: revisionId,
      plan_version: 2,
      plan_revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64),
    },
  };
}

const features: PlanFeatures = {
  profile_id: 7,
  overrides: { spoolman: true },
  effective: {
    farm: { enabled: false, source: "default" },
    orders: { enabled: false, source: "default" },
    bambu: { enabled: false, source: "default" },
    spoolman: { enabled: true, source: "plan" },
  },
};

describe("Plan workspace read selection", () => {
  afterEach(() => {
    healthState.capabilities = [];
    cleanup();
  });

  it("workspace_flag_off_preserves_query_path", async () => {
    healthState.capabilities = [];
    vi.mocked(fetchPlanReview).mockResolvedValue(reviewFor(11));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => usePlanReviewQuery(7, { revisionId: 11 }), { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(fetchPlanReview).toHaveBeenCalledWith(7, { includeExcluded: false });
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false, true))?.accepted_basis?.plan_revision_id).toBe(11);
    expect(client.getQueryData(queryKeys.planReview(7, false, true, 11))).toBeUndefined();
  });

  it("workspace_rebuild_read_keeps_revision_identity", async () => {
    healthState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const mismatched = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    mismatched.setQueryData(queryKeys.planFeatures(7), features);
    vi.mocked(fetchPlanReview).mockClear();
    vi.mocked(fetchPlanReview).mockResolvedValue(reviewFor(4));
    const refused = renderHook(() => usePlanReviewQuery(7, { revisionId: 11 }), { wrapper: wrapper(mismatched) });
    await waitFor(() => expect(refused.result.current.isError).toBe(true));
    expect(fetchPlanReview).toHaveBeenCalledTimes(1);
    expect(mismatched.getQueryData(queryKeys.planReview(7, false, true, 11))).toBeUndefined();
    refused.unmount();

    const asked = { revisionId: 11 };
    vi.mocked(fetchPlanReview).mockImplementation(async () => reviewFor(asked.revisionId));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.planFeatures(7), features);
    const hook = renderHook(() => usePlanReviewQuery(7, { revisionId: asked.revisionId }), { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.data?.accepted_basis?.plan_revision_id).toBe(11));
    asked.revisionId = 4;
    hook.rerender();
    await waitFor(() => expect(hook.result.current.data?.accepted_basis?.plan_revision_id).toBe(4));
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false, true, 11))?.accepted_basis?.plan_revision_id).toBe(11);
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false, true, 4))?.accepted_basis?.plan_revision_id).toBe(4);
    expect(fetchPlanReview).toHaveBeenCalledWith(7, { includeExcluded: false });
  });

  it("workspace_rebuild_read_keeps_unrevised_identity", async () => {
    healthState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    client.setQueryData(queryKeys.planFeatures(7), features);
    const unrevised = { ...review, profile_id: 7, accepted_basis: null };
    vi.mocked(fetchPlanReview).mockClear();
    vi.mocked(fetchPlanReview).mockResolvedValue(reviewFor(4));
    const refused = renderHook(() => usePlanReviewQuery(7, { revisionId: null }), { wrapper: wrapper(client) });
    await waitFor(() => expect(refused.result.current.isError).toBe(true));
    expect(fetchPlanReview).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.planReview(7, false, true, null))).toBeUndefined();
    refused.unmount();

    vi.mocked(fetchPlanReview).mockResolvedValue(unrevised);
    const kept = renderHook(() => usePlanReviewQuery(7, { revisionId: null }), { wrapper: wrapper(client) });
    await waitFor(() => expect(kept.result.current.data?.accepted_basis).toBeNull());
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false, true, null))?.accepted_basis).toBeNull();
    kept.unmount();

    const placeholderClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    placeholderClient.setQueryData(queryKeys.planFeatures(7), features);
    let release: (value: PlanReview) => void = () => {};
    vi.mocked(fetchPlanReview).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const shown = renderHook(
      ({ revisionId }: { revisionId: number | null }) => usePlanReviewQuery(7, { revisionId }),
      { wrapper: wrapper(placeholderClient), initialProps: { revisionId: 4 as number | null } },
    );
    await act(async () => { release(reviewFor(4)); });
    await waitFor(() => expect(shown.result.current.data?.accepted_basis?.plan_revision_id).toBe(4));
    shown.rerender({ revisionId: null });
    expect(shown.result.current.isPlaceholderData).toBe(false);
    expect(shown.result.current.data).toBeUndefined();
    await act(async () => { release(unrevised); });
    await waitFor(() => expect(shown.result.current.data?.accepted_basis).toBeNull());
    shown.rerender({ revisionId: 11 });
    expect(shown.result.current.isPlaceholderData).toBe(false);
    expect(shown.result.current.data).toBeUndefined();
    shown.unmount();
  });
});

describe("Plan review mutations", () => {
  it.each(["progress", "assembly"] as const)("keeps the Review when a failed %s save targets a missing part", async (kind) => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    for (const allowed of [true, false]) queryClient.setQueryData(queryKeys.planReview(1, false, allowed), review);
    const api = kind === "progress" ? vi.mocked(patchPartProgress) : vi.mocked(patchPartAssembled);
    api.mockRejectedValueOnce(new Error("Part no longer exists"));
    const { result } = renderHook(() => {
      const progress = usePatchPartProgressMutation(1);
      const assembly = usePatchPartAssembledMutation(1);
      return kind === "progress" ? progress : assembly;
    }, { wrapper: wrapper(queryClient) });
    await act(async () => {
      await expect(result.current.mutateAsync({ partId: 999, unitIndex: 0, completed: true, assembled: true })).rejects.toThrow("Part no longer exists");
    });
    for (const allowed of [true, false]) expect(queryClient.getQueryData(queryKeys.planReview(1, false, allowed))).toEqual(review);
    queryClient.clear();
  });

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
    act(() => result.current.mutate({ partId: 42, unitIndex: completed ? 3 : 0, completed }));
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

  it("updates cached progress without a caller-supplied review", async () => {
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

    expect(queryClient.getQueryData<PlanReview>(queryKeys.planReview(1))?.part_groups[0]?.parts[0]?.print_units).toEqual([true]);
  });

  it("updates cached assembly without a caller-supplied review", async () => {
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

    expect(queryClient.getQueryData<PlanReview>(queryKeys.planReview(1))?.part_groups[0]?.parts[0]?.assembled_units).toEqual([true]);
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
    act(() => { save = hook.result.current.mutateAsync({ partId: 42, unitIndex: 0, completed: true, assembled: true }); });
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


describe("Plan mutation field ownership and rollback isolation", () => {
  it.each((["progress", "assembly"] as const).flatMap((kind) =>
    (["removed", "masked", "stale", "cancel", "absent"] as const).map((transition) => ({ kind, transition })),
  ))("preserves inventory through $kind rollback with $transition cache", async ({ kind, transition }) => {
    const enriched = structuredClone(review);
    Object.assign(enriched.part_groups[0]!.parts[0]!, {
      filament_color_id: "spoolman:inventory:filament:7", filament_display: "Old inventory",
      filament_hex: "#123456", spoolman_spool_id: "99", spool_badge: "400g left", assembled_units: [],
    });
    const masked = structuredClone(enriched);
    Object.assign(masked.part_groups[0]!.parts[0]!, {
      filament_display: "", filament_hex: null, spool_badge: null, spoolman_spool_id: "100",
    });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const key = queryKeys.planReview(1, false);
    if (transition !== "absent") queryClient.setQueryData(key, ["stale", "masked"].includes(transition) ? masked : enriched);
    if (transition === "cancel") {
      const cancel = queryClient.cancelQueries.bind(queryClient);
      vi.spyOn(queryClient, "cancelQueries").mockImplementation(async (filters) => {
        await cancel(filters);
        queryClient.setQueryData(key, masked);
      });
    }
    let rejectSave: (error: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => { rejectSave = reject; });
    const api = kind === "progress" ? vi.mocked(patchPartProgress) : vi.mocked(patchPartAssembled);
    api.mockClear();
    api.mockReturnValueOnce(pending);
    const hook = renderHook(() => {
      const progress = usePatchPartProgressMutation(1, false);
      const assembly = usePatchPartAssembledMutation(1, false);
      return kind === "progress" ? progress : assembly;
    }, { wrapper: wrapper(queryClient) });
    act(() => hook.result.current.mutate({ partId: 42, unitIndex: 0, completed: true,
      assembled: true }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    if (transition === "masked") queryClient.setQueryData(key, masked);
    if (transition === "removed") queryClient.removeQueries({ queryKey: key, exact: true });
    if (transition === "removed" || transition === "absent") {
      expect(queryClient.getQueryData(key)).toBeUndefined();
    } else {
      const part = queryClient.getQueryData<PlanReview>(key)!.part_groups[0]!.parts[0]!;
      expect(part).toMatchObject({ filament_display: "", filament_hex: null,
        spool_badge: null, spoolman_spool_id: "100" });
    }
    act(() => rejectSave(new Error("Save failed")));
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    if (transition === "removed" || transition === "absent") {
      expect(queryClient.getQueryData(key)).toBeUndefined();
    } else {
      expect(queryClient.getQueryData<PlanReview>(key)?.part_groups[0]?.parts[0]).toMatchObject({
        filament_display: "", filament_hex: null, spool_badge: null, spoolman_spool_id: "100",
        print_units: [false], printed_count: 0, assembled_units: [], missing: true,
      });
    }
    hook.unmount();
    queryClient.clear();
    vi.restoreAllMocks();
  });
});
