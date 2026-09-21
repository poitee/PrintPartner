// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import LoginPage from "./LoginPage";

const auth = vi.hoisted(() => ({
  user: null,
  multiUser: true,
  authRequired: true,
  registrationOpen: true,
  githubOAuth: false,
  discordOAuth: false,
  loading: false,
  loginEmail: vi.fn(),
  registerEmail: vi.fn(),
}));

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
