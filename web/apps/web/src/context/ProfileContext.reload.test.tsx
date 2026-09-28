// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { fetchProfiles } from "../api/endpoints/plans";
import { ProfileProvider, useProfileSelection } from "./ProfileContext";

vi.mock("../api/endpoints/plans", () => ({ fetchProfiles: vi.fn(async () => []) }));
vi.mock("./AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: false, loading: false }),
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, loading: false }),
}));

afterEach(cleanup);

it("reloads the Build list with one request", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useProfileSelection(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProfileProvider>{children}</ProfileProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.profilesLoaded).toBe(true));
  expect(fetchProfiles).toHaveBeenCalledTimes(1);

  await act(() => result.current.reloadProfiles());

  expect(fetchProfiles).toHaveBeenCalledTimes(2);
});
