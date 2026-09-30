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

vi.mock("../api/endpoints/auth", () => ({
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
    expect(screen.getByRole("main")).toBeTruthy();
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
    expect(screen.getByRole("main")).toBeTruthy();
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

  it("shows forgot-password failures inline and preserves the email for retry", async () => {
    api.requestPasswordReset
      .mockRejectedValueOnce(new Error("Could not reach the mail service"))
      .mockResolvedValueOnce({ message: "Sent" });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    const email = screen.getByRole("textbox", { name: "Email" });
    await user.type(email, "person@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not reach the mail service",
    );
    expect((email as HTMLInputElement).value).toBe("person@example.com");

    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(api.requestPasswordReset).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("shows password mismatch inline and preserves both password fields", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/reset-password?token=test-token"]}>
        <ResetPasswordPage />
      </MemoryRouter>,
    );

    const password = screen.getByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm password");
    await user.type(password, "password123");
    await user.type(confirm, "password456");
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Passwords do not match",
    );
    expect((password as HTMLInputElement).value).toBe("password123");
    expect((confirm as HTMLInputElement).value).toBe("password456");
    expect(api.resetPasswordWithToken).not.toHaveBeenCalled();
  });

  it("shows rejected password resets inline and allows retry", async () => {
    api.resetPasswordWithToken
      .mockRejectedValueOnce(new Error("This reset link is invalid or expired"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/reset-password?token=test-token"]}>
        <ResetPasswordPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Confirm password"), "password123");
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This reset link is invalid or expired",
    );
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(
      "password123",
    );

    await user.click(screen.getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(api.resetPasswordWithToken).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
