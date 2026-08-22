// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { setProfileBaseLayer, type ProfileLayer } from "../api/engine";
import { queryKeys } from "./keys";
import {
  useDeletePlanLayerMutation,
  useSetPlanBaseLayerMutation,
} from "./planLayers";

const baseLayer = (projectId: number): ProfileLayer => ({
  id: 1,
  layer_order: 0,
  layer_type: "base",
  project_id: projectId,
  project_name: `Source ${projectId}`,
});

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    setProfileBaseLayer: vi.fn(async (_profileId: number, sourceId: number) => [
      baseLayer(sourceId),
    ]),
    deleteProfileLayer: vi.fn().mockResolvedValue(undefined),
  };
});

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("Plan layer queries", () => {
  afterEach(cleanup);

  it("publishes complete mutation results without changing another Plan", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.planLayers(1), [baseLayer(10)]);
    queryClient.setQueryData(queryKeys.planLayers(2), [baseLayer(20)]);
    const { result } = renderHook(() => useSetPlanBaseLayerMutation(1), {
      wrapper: wrapper(queryClient),
    });

    await act(() => result.current.mutateAsync(11));

    expect(queryClient.getQueryData(queryKeys.planLayers(1))).toEqual([baseLayer(11)]);
    expect(queryClient.getQueryData(queryKeys.planLayers(2))).toEqual([baseLayer(20)]);
  });

  it("invalidates only the selected Plan layers after delete", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.planLayers(1), [baseLayer(10)]);
    queryClient.setQueryData(queryKeys.planLayers(2), [baseLayer(20)]);
    const { result } = renderHook(() => useDeletePlanLayerMutation(1), {
      wrapper: wrapper(queryClient),
    });

    await act(() => result.current.mutateAsync(1));

    expect(queryClient.getQueryState(queryKeys.planLayers(1))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.planLayers(2))?.isInvalidated).toBe(false);
  });

  it("serializes writes for the same Plan so an older response cannot win", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let resolveFirst: ((layers: ProfileLayer[]) => void) | undefined;
    const setBase = vi.mocked(setProfileBaseLayer);
    setBase.mockClear();
    setBase
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce([baseLayer(12)]);
    const { result } = renderHook(
      () => ({
        first: useSetPlanBaseLayerMutation(1),
        second: useSetPlanBaseLayerMutation(1),
      }),
      { wrapper: wrapper(queryClient) },
    );

    let firstWrite: Promise<ProfileLayer[]>;
    let secondWrite: Promise<ProfileLayer[]>;
    act(() => {
      firstWrite = result.current.first.mutateAsync(11);
      secondWrite = result.current.second.mutateAsync(12);
    });

    await waitFor(() => expect(resolveFirst).toBeDefined());
    const callsBeforeFirstResolved = setBase.mock.calls.length;
    resolveFirst?.([baseLayer(11)]);
    await act(async () => {
      await firstWrite;
      await secondWrite;
    });

    expect(callsBeforeFirstResolved).toBe(1);
    expect(setProfileBaseLayer).toHaveBeenNthCalledWith(1, 1, 11);
    expect(setProfileBaseLayer).toHaveBeenNthCalledWith(2, 1, 12);
    expect(queryClient.getQueryData(queryKeys.planLayers(1))).toEqual([baseLayer(12)]);
  });
});
