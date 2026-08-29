// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const runtime = vi.hoisted(() => ({
  profileModuleLoads: 0,
}));

vi.mock("./context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ user: null, multiUser: true, loading: false }),
}));

vi.mock("./context/ProfileContext", () => {
  runtime.profileModuleLoads += 1;
  return {
    ProfileProvider: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("./context/DateFormatContext", () => ({
  DateFormatProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/JobContext", () => ({
  JobProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/PlanActionsContext", () => ({
  PlanActionsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/PlanWorkspaceContext", () => ({
  PlanWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./context/StlAutoSyncContext", () => ({
  StlAutoSyncProvider: ({ children }: { children: ReactNode }) => children,
  useStlAutoSync: () => ({
    busy: false,
    failed: false,
    missingCount: 0,
    emptyThumbCount: 0,
    banner: { kind: "hidden" as const },
    runSync: () => undefined,
  }),
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

vi.mock("./pages/LoginPage", () => ({
  default: () => <h1>Public login</h1>,
}));

import App from "./App";

describe("public route loading", () => {
  afterEach(cleanup);

  it("does not load authenticated workspace providers for the login route", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Public login" })).toBeTruthy();
    expect(runtime.profileModuleLoads).toBe(0);
  });
});
