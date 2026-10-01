// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProfileLayer } from "../api/endpoints/plans";
import { queryKeys } from "./keys";
import { useDeleteSourceMutation } from "./sources";

vi.mock("../api/endpoints/sources", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/endpoints/sources")>(),
  deleteSource: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

it("refreshes every Build's current attachments after deleting a shared Source", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const layer: ProfileLayer = {
    id: 1, layer_order: 0, layer_type: "base", project_id: 7, project_name: "Deleted Source",
  };
  queryClient.setQueryData(queryKeys.planLayers(1), [layer]);
  queryClient.setQueryData(queryKeys.planLayers(2), [layer]);
  const { result } = renderHook(() => useDeleteSourceMutation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  await act(() => result.current.mutateAsync(7));

  expect(queryClient.getQueryState(queryKeys.planLayers(1))?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(queryKeys.planLayers(2))?.isInvalidated).toBe(true);
});
