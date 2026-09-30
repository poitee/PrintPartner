// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { AuthUser } from "../api/endpoints/auth";
import LoginPage from "./LoginPage";

const auth = vi.hoisted(() => ({
  user: null as AuthUser | null,
  multiUser: true,
  authRequired: true,
  registrationOpen: true,
  githubOAuth: false,
  discordOAuth: false,
  loading: false,
  loginEmail: vi.fn(),
  registerEmail: vi.fn(),
}));

function LocationOutput() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}

vi.mock("../context/AuthContext", () => ({
  useAuth: () => auth,
}));
vi.mock("../api/endpoints/auth", () => ({
  authOAuthUrl: (provider: string) => `/auth/${provider}`,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("LoginPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    auth.user = null;
    auth.multiUser = true;
    auth.registrationOpen = true;
    auth.githubOAuth = false;
    auth.discordOAuth = false;
    auth.loginEmail.mockReset().mockResolvedValue(undefined);
    auth.registerEmail.mockReset().mockResolvedValue(undefined);
  });

  it("explains first-run setup and acknowledges the administrator account", async () => {
    auth.multiUser = false;
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/setup"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Set up Print Partner",
    );
    expect(screen.getByText(/existing printers, builds, and settings/i)).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Shop owner");
    await user.type(screen.getByRole("textbox", { name: "Email" }), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create administrator" }));

    expect(await screen.findByRole("heading", { name: "Administrator account created" })).toBeTruthy();
    expect(screen.getByText(/existing Print Partner data is connected/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue to Print Partner" })).toBeTruthy();
  });

  it("exposes the page title as its h1", () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Print Partner");
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("acknowledges an existing single-user administrator", () => {
    auth.multiUser = false;
    auth.registrationOpen = false;
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Sign in to Print Partner",
    );
    expect(screen.getByText(/already has an administrator account/i)).toBeTruthy();
    expect(screen.queryByText(/Need an account/i)).toBeNull();
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

  it("shows a generic inline error and preserves the email for a retry", async () => {
    auth.loginEmail
      .mockRejectedValueOnce(new Error("HTTP 401: account-specific detail"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/progress?profile=7" } }]}>
        <LoginPage />
      </MemoryRouter>,
    );

    const email = screen.getByRole("textbox", { name: "Email" });
    await user.type(email, "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not sign in. Check your email and password, then try again.",
    );
    expect(screen.queryByText(/account-specific detail/i)).toBeNull();
    expect((email as HTMLInputElement).value).toBe("operator@example.com");

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(auth.loginEmail).toHaveBeenCalledTimes(2));
    expect(auth.loginEmail).toHaveBeenLastCalledWith(
      "operator@example.com",
      "correct-password",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows registration failures inline on the public auth screen", async () => {
    auth.registerEmail.mockRejectedValueOnce(new Error("Registration is unavailable"));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Need an account? Register" }));
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Operator");
    await user.type(screen.getByRole("textbox", { name: "Email" }), "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "account-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Registration is unavailable",
    );
  });

  it("returns an authenticated user to the intended destination", async () => {
    auth.user = {
      user_id: "user-1",
      login: "operator@example.com",
      display_name: "Operator",
      email: "operator@example.com",
      provider: "email",
      is_admin: true,
    };
    render(
      <MemoryRouter
        initialEntries={[{ pathname: "/login", state: { from: "/progress?profile=7" } }]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/progress" element={<LocationOutput />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findByRole("status")).textContent).toBe("/progress?profile=7");
  });

  it("hides Discord unless that provider is configured", () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Continue with Discord" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).toBeNull();
  });

  it("shows GitHub when health advertises github_oauth", () => {
    auth.githubOAuth = true;
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Continue with Discord" })).toBeNull();
  });
});
