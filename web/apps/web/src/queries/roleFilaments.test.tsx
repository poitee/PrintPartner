// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY } from "@print-partner/contracts";
import type { ReactNode } from "react";
import { fetchRoleFilaments, type RoleFilamentRow } from "../api/endpoints/filaments";
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

vi.mock("../api/endpoints/filaments", () => ({
  fetchRoleFilaments: vi.fn(async (profileId: number) => [role(profileId)]),
}));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("role filament queries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { filament_color_id: " spoolman:int-1:filament:2 ", spoolman_spool_id: null },
    { filament_color_id: null, spoolman_spool_id: " spoolman:int-1:spool:5 " },
    { filament_color_id: "catalog:red", spoolman_spool_id: "spoolman:int-1:spool:5" },
  ])("masks denied role enrichment for assignment %j", async (assignment) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    queryClient.setQueryData(queryKeys.planFeatures(1), {
      profile_id: 1, effective: { spoolman: { enabled: false, source: "plan" } },
    });
    const assignedRole = { ...role(1), ...assignment, filament_display: "Spoolman Blue", filament_hex: "#0000ff", filament_custom_hex: "#123456" };
    const catalogRole = { ...role(1), role: "accent", filament_color_id: "catalog:red", spoolman_spool_id: "  " };
    vi.mocked(fetchRoleFilaments).mockResolvedValueOnce([assignedRole, catalogRole]);
    queryClient.setQueryData(queryKeys.roleFilaments(1, false), [assignedRole, catalogRole]);
    const { result, unmount } = renderHook(() => useRoleFilamentsQuery(1), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { ...assignedRole, filament_display: assignment.filament_color_id ?? "", filament_hex: "#123456" },
      catalogRole,
    ]);
    expect(queryClient.getQueryData(queryKeys.roleFilaments(1, false))).toEqual([assignedRole, catalogRole]);
    unmount();
    queryClient.clear();
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
