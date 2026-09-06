// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProfileSummary } from "@print-partner/contracts";
import { fetchProfile, touchProfileLastUsed, updateProfile } from "../api/endpoints/plans";
import { queryKeys } from "./keys";
import {
  useTouchProfileLastUsedMutation,
  useUpdateProfileMutation,
  refreshProfileSummary,
} from "./profiles";

vi.mock("../api/endpoints/plans", () => ({
  fetchProfile: vi.fn(),
  touchProfileLastUsed: vi.fn(),
  updateProfile: vi.fn(),
}));

const profile: ProfileSummary = {
  id: 7,
  name: "Plan",
  order_number: null,
  special_request: null,
  part_count: 4,
  accepted_progress: { kind: "ready", total_units: 6, remaining_units: 2 },
  build_stale: false,
  freshness: {
    status: "untracked",
    accepted_input_set_id: null,
    accepted_at: null,
    reasons: [{ kind: "no_accepted_inputs" }],
  },
  archived_at: null,
  last_used_at: null,
};

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("Profile summary mutation cache", () => {
  it("refreshes only the changed Build without replacing other cached Builds", async () => {
    const client = new QueryClient();
    const other = { ...profile, id: 8, name: "Other" };
    const updated = { ...profile, part_count: 5 };
    client.setQueryData(queryKeys.profiles, [profile, other]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(fetchProfile).mockResolvedValueOnce(updated);
    await refreshProfileSummary(client, 7);
    expect(fetchProfile).toHaveBeenCalledWith(7);
    expect(client.getQueryData(queryKeys.profiles)).toEqual([updated, other]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not restore a Build removed while its summary request is pending", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.profiles, [profile]);
    vi.mocked(fetchProfile).mockImplementationOnce(async () => {
      client.setQueryData(queryKeys.profiles, []);
      return profile;
    });
    await refreshProfileSummary(client, 7);
    expect(client.getQueryData(queryKeys.profiles)).toEqual([]);
  });

  it("preserves cached summaries when the targeted refresh fails", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.profiles, [profile]);
    vi.mocked(fetchProfile).mockRejectedValueOnce(new Error("offline"));
    await expect(refreshProfileSummary(client, 7)).rejects.toThrow("offline");
    expect(client.getQueryData(queryKeys.profiles)).toEqual([profile]);
  });

  it("invalidates the collection when no complete list is cached", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await refreshProfileSummary(client, 7);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.profiles });
    expect(client.getQueryData(queryKeys.profiles)).toBeUndefined();
  });

  it("replaces a mutation row with its nested accepted Progress", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.profiles, [profile]);
    const updated: ProfileSummary = {
      ...profile,
      name: "Renamed",
      accepted_progress: { kind: "unavailable", reason: "concurrent_update" },
    };
    vi.mocked(updateProfile).mockResolvedValueOnce(updated);
    const { result } = renderHook(() => useUpdateProfileMutation(), {
      wrapper: wrapper(queryClient),
    });

    await act(() => result.current.mutateAsync({ id: profile.id, name: "Renamed" }));

    expect(queryClient.getQueryData(queryKeys.profiles)).toEqual([updated]);
  });

  it("merges a delayed touch timestamp without restoring stale archive or Progress state", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current: ProfileSummary = {
      ...profile,
      archived_at: "2026-08-21T12:00:00.000Z",
      accepted_progress: { kind: "unavailable", reason: "integrity" },
    };
    queryClient.setQueryData(queryKeys.profiles, [current]);
    vi.mocked(touchProfileLastUsed).mockResolvedValueOnce({
      ...profile,
      archived_at: null,
      last_used_at: "2026-08-21T11:59:00.000Z",
    });
    const { result } = renderHook(() => useTouchProfileLastUsedMutation(), {
      wrapper: wrapper(queryClient),
    });

    await act(() => result.current.mutateAsync(profile.id));

    expect(queryClient.getQueryData(queryKeys.profiles)).toEqual([
      { ...current, last_used_at: "2026-08-21T11:59:00.000Z" },
    ]);
  });
});
