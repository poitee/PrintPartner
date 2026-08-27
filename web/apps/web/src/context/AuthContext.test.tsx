// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../queries/keys";
import { AuthProvider, useAuth } from "./AuthContext";

const api = vi.hoisted(() => ({
  fetchAuthMe: vi.fn(),
  fetchHealth: vi.fn(),
  loginWithEmail: vi.fn(),
  logout: vi.fn(),
  registerWithEmail: vi.fn(),
  setEngineUnauthorizedHandler: vi.fn(),
}));

vi.mock("../api/contractRequest", () => ({
  setEngineUnauthorizedHandler: api.setEngineUnauthorizedHandler,
}));

vi.mock("../api/endpoints/auth", () => ({
  fetchAuthMe: api.fetchAuthMe,
  loginWithEmail: api.loginWithEmail,
  logout: api.logout,
  registerWithEmail: api.registerWithEmail,
}));

vi.mock("../api/endpoints/help", () => ({
  fetchHealth: api.fetchHealth,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthProvider", () => {
  it("does not request the current user when health reports no session", async () => {
    api.fetchHealth.mockResolvedValue({
      multi_user: true,
      authentication_required: true,
      authenticated: false,
    });
    api.fetchAuthMe.mockResolvedValue({
      user: {
        user_id: "unexpected-user",
        login: "unexpected@example.com",
        display_name: "Unexpected",
        email: "unexpected@example.com",
        provider: "email",
        is_admin: false,
      },
      multi_user: true,
    });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const hook = renderHook(useAuth, { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    expect(hook.result.current.user).toBeNull();
    expect(api.fetchAuthMe).not.toHaveBeenCalled();
  });

  it("discards tenant data cached before email login", async () => {
    api.fetchHealth.mockResolvedValue({ multi_user: true });
    api.fetchAuthMe.mockRejectedValue(new Error("401"));
    api.loginWithEmail.mockResolvedValue({
      user: {
        user_id: "user-1",
        login: "operator@example.com",
        display_name: "Operator",
        email: "operator@example.com",
        provider: "email",
        is_admin: false,
      },
    });
    const client = new QueryClient();
    client.setQueryData(queryKeys.profiles, []);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const hook = renderHook(useAuth, { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.loginEmail("operator@example.com", "password123");
    });

    expect(client.getQueryData(queryKeys.profiles)).toBeUndefined();
  });
});
