// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import LoginPage from "./LoginPage";

const auth = vi.hoisted(() => ({
  loginEmail: vi.fn(),
  registerEmail: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: null,
    multiUser: true,
    loading: false,
    loginEmail: auth.loginEmail,
    registerEmail: auth.registerEmail,
  }),
}));
vi.mock("../api/engine", () => ({
  authOAuthUrl: (provider: string) => `/auth/${provider}`,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("LoginPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    auth.loginEmail.mockReset().mockResolvedValue(undefined);
    auth.registerEmail.mockReset().mockResolvedValue(undefined);
  });

  it("exposes the page title as its h1", () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Print Partner");
  });

  it("submits credentials when Enter is pressed in the password field", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Email" }),
      "operator@example.com",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "shop-floor-password{Enter}",
    );

    await waitFor(() => {
      expect(auth.loginEmail).toHaveBeenCalledWith(
        "operator@example.com",
        "shop-floor-password",
      );
    });
  });
});
