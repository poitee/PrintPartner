// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

vi.mock("./context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
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

const loginPageModule = vi.hoisted(() => {
  let resolveModule!: (value: { default: () => ReactNode }) => void;
  const promise = new Promise<{ default: () => ReactNode }>((resolve) => {
    resolveModule = resolve;
  });
  return {
    promise,
    resolve(value: { default: () => ReactNode }) {
      resolveModule(value);
    },
  };
});

vi.mock("./pages/LoginPage", () => loginPageModule.promise);

describe("lazy route loading", () => {
  afterEach(cleanup);

  it("announces page loading until the finite route import resolves", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );

    const loading = screen.getByRole("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-atomic")).toBe("true");
    expect(loading.getAttribute("aria-label")).toBeNull();
    expect(loading.textContent).toContain("Loading");

    loginPageModule.resolve({
      default: () => <div>Login route loaded</div>,
    });

    expect((await screen.findByText("Login route loaded")).textContent).toBe(
      "Login route loaded",
    );
  });
});
