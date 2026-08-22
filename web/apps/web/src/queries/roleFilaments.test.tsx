// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fetchRoleFilaments, type RoleFilamentRow } from "../api/engine";
import { queryKeys } from "./keys";
import {
  invalidateRoleFilaments,
  publishRoleFilaments,
  useRoleFilamentsQuery,
} from "./roleFilaments";

const role = (profileId: number): RoleFilamentRow => ({
  role: "primary",
  part_count: profileId,
  filament_color_id: null,
  filament_custom_hex: null,
  filament_display: `Plan ${profileId}`,
  filament_hex: null,
});

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    fetchRoleFilaments: vi.fn(async (profileId: number) => [role(profileId)]),
  };
});

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("role filament queries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps reads and invalidation scoped to one Plan", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.roleFilaments(2), [role(2)]);
    const { result, unmount } = renderHook(() => useRoleFilamentsQuery(1), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchRoleFilaments).toHaveBeenCalledWith(1);
    expect(result.current.data).toEqual([role(1)]);
    expect(queryClient.getQueryData(queryKeys.roleFilaments(2))).toEqual([role(2)]);

    publishRoleFilaments(queryClient, 1, [role(3)]);
    await waitFor(() => expect(result.current.data).toEqual([role(3)]));

    unmount();
    await invalidateRoleFilaments(queryClient, 1);

    expect(queryClient.getQueryState(queryKeys.roleFilaments(1))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.roleFilaments(2))?.isInvalidated).toBe(false);
  });
});
