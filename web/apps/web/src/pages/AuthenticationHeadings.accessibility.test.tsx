// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ForgotPasswordPage from "./ForgotPasswordPage";
import ResetPasswordPage from "./ResetPasswordPage";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: null,
    multiUser: true,
    authRequired: true,
    registrationOpen: true,
    loading: false,
    refresh: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));

vi.mock("../api/engine", () => ({
  requestPasswordReset: api.requestPasswordReset,
  resetPasswordWithToken: api.resetPasswordWithToken,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("authentication page headings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    api.requestPasswordReset.mockReset();
    api.requestPasswordReset.mockResolvedValue({ message: "Sent" });
    api.resetPasswordWithToken.mockReset();
    api.resetPasswordWithToken.mockResolvedValue(undefined);
  });

  it("uses an h1 for the forgot-password page title", () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reset password");
  });

  it("uses an h1 for the reset-password page title", () => {
    render(
      <MemoryRouter initialEntries={["/reset-password?token=test-token"]}>
        <ResetPasswordPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Choose a new password",
    );
  });

  it("submits the forgot-password form with Enter", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com{Enter}");

    await waitFor(() => {
      expect(api.requestPasswordReset).toHaveBeenCalledWith("person@example.com");
    });
  });

  it("submits the reset-password form with Enter", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/reset-password?token=test-token"]}>
        <ResetPasswordPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Confirm password"), "password123{Enter}");

    await waitFor(() => {
      expect(api.resetPasswordWithToken).toHaveBeenCalledWith("test-token", "password123");
    });
  });
});
