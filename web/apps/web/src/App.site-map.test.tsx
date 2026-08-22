// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet } from "react-router-dom";
import App from "./App";

vi.mock("./context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ user: { id: 1 }, multiUser: false, loading: false }),
}));
vi.mock("./context/JobContext", () => ({
  JobProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/ProfileContext", () => ({
  ProfileProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/PlanActionsContext", () => ({
  PlanActionsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/PlanWorkspaceContext", () => ({
  PlanWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/StlAutoSyncContext", () => ({
  StlAutoSyncProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/ImportRulesSaveContext", () => ({
  ImportRulesSaveProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/KitManifestSaveContext", () => ({
  KitManifestSaveProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/SaveStatusContext", () => ({
  SaveStatusProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/AuthGate", () => ({
  default: function AuthGate() {
    return <Outlet />;
  },
}));
vi.mock("./layout/AppLayout", () => ({
  default: function Layout() {
    return <Outlet />;
  },
}));
vi.mock("./pages/PlansPage", () => ({
  default: () => <h1>Builds landing</h1>,
}));
vi.mock("./pages/ExportPage", () => ({
  default: () => <h1>Build Production</h1>,
}));
vi.mock("./pages/GlobalProductionPage", () => ({
  default: () => <h1>Global Production</h1>,
}));
vi.mock("./pages/BuildPage", () => ({ default: () => <h1>Sources</h1> }));
vi.mock("./pages/PartsPage", () => ({ default: () => <h1>Plan</h1> }));
vi.mock("./pages/CheckoffPage", () => ({ default: () => <h1>Checkoff</h1> }));
vi.mock("./pages/SourcesPage", () => ({ default: () => <h1>Library</h1> }));
vi.mock("./pages/PrintersPage", () => ({ default: () => <h1>Printers</h1> }));
vi.mock("./pages/SettingsPage", () => ({ default: () => <h1>Settings</h1> }));
vi.mock("./pages/HelpPage", () => ({ default: () => <h1>Help</h1> }));
vi.mock("./pages/LoginPage", () => ({ default: () => <h1>Login</h1> }));
vi.mock("./pages/ForgotPasswordPage", () => ({ default: () => <h1>Forgot</h1> }));
vi.mock("./pages/ResetPasswordPage", () => ({ default: () => <h1>Reset</h1> }));

describe("accepted site map routes", () => {
  afterEach(cleanup);

  it("opens Builds from /", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Builds landing" })).textContent).toBe(
      "Builds landing",
    );
  });

  it("redirects /plans to Builds", async () => {
    render(
      <MemoryRouter initialEntries={["/plans?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Builds landing" })).textContent).toBe(
      "Builds landing",
    );
  });

  it("opens Sources at /sources and Plan at /plan", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/sources?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Sources" })).textContent).toBe("Sources");
    unmount();

    render(
      <MemoryRouter initialEntries={["/plan?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Plan" })).textContent).toBe("Plan");
  });

  it("redirects /parts to Plan and keeps /library as the source registry", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/parts?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Plan" })).textContent).toBe("Plan");
    unmount();

    render(
      <MemoryRouter initialEntries={["/library"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Library" })).textContent).toBe("Library");
  });

  it("opens global Production at /production and Build Production at /export", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/production"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Global Production" })).textContent).toBe(
      "Global Production",
    );
    unmount();

    render(
      <MemoryRouter initialEntries={["/export?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Build Production" })).textContent).toBe(
      "Build Production",
    );
  });

  it("sends a profile on /production to Build Production", async () => {
    render(
      <MemoryRouter initialEntries={["/production?profile=7"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Build Production" })).textContent).toBe(
      "Build Production",
    );
  });

  it("keeps an invalid profile on Global Production", async () => {
    render(
      <MemoryRouter initialEntries={["/production?profile=1.5"]}>
        <App />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("heading", { name: "Global Production" })).textContent).toBe(
      "Global Production",
    );
  });
});
