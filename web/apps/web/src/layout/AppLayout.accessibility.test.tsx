// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import AppLayout from "./AppLayout";
import BuildSaveNavigationGuard from "../components/BuildSaveNavigationGuard";
import { useImportRulesAutosave } from "../hooks/useImportRulesAutosave";

vi.mock("../components/CommandPalette", () => ({ default: () => null }));
vi.mock("../components/JobTray", () => ({ default: () => null }));
vi.mock("../components/SupportCta", () => ({ default: () => null }));
vi.mock("../components/CreatePlanButton", () => ({ default: () => <button type="button">Create</button> }));
vi.mock("../components/SaveStatusIndicator", () => ({ default: () => null }));
vi.mock("../components/UserMenu", () => ({ default: () => null }));
vi.mock("../components/WorkflowProgress", () => ({ default: () => null }));
vi.mock("../components/layout/SpineRail", () => ({ default: () => <aside>Print Partner</aside> }));
vi.mock("../components/UpdateAvailableBanner", () => ({
  default: () => null,
  dismissUpdateBanner: vi.fn(),
  isUpdateBannerDismissed: () => false,
}));
vi.mock("../components/ThemePreferenceControl", () => ({ default: () => null }));
vi.mock("../components/sources/SourceUpdateNotice", () => ({ default: () => null }));
vi.mock("../components/PlanPicker", () => ({ default: () => <button type="button">Plan</button> }));
vi.mock("../components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../hooks/useProfileUrlSync", () => ({ useProfileUrlSync: vi.fn() }));
vi.mock("../hooks/useAppUpdateCheck", () => ({ useAppUpdateCheck: () => ({ updateCheck: null }) }));
vi.mock("../queries/sources", () => ({ useSourcesQuery: () => ({ data: [] }) }));
const workflowState = vi.hoisted(() => ({
  stages: [] as Array<{ id: string; label: string }>,
  activeId: null as string | null,
}));
const profileState = vi.hoisted(() => ({
  selectedProfileId: null as number | null,
  profiles: [] as Array<{ id: number; name: string }>,
}));
vi.mock("../hooks/useWorkflowStages", () => ({
  useWorkflowStages: () => workflowState,
}));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: { ok: true } }) }));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => profileState,
}));
const saveRegistry = vi.hoisted(() => ({
  flush: vi.fn(),
  registered: new Map<number, () => Promise<void>>(),
  saveImportRules: vi.fn(),
}));
vi.mock("../api/endpoints/sources", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/endpoints/sources")>(),
  saveImportRules: saveRegistry.saveImportRules,
}));
vi.mock("../context/ImportRulesSaveContext", () => ({
  useImportRulesSaveRegistry: () => ({
    flushAll: saveRegistry.flush,
    registerFlush: (id: number, flush: () => Promise<void>) => saveRegistry.registered.set(id, flush),
    unregisterFlush: (id: number) => saveRegistry.registered.delete(id),
  }),
}));
vi.mock("../context/KitManifestSaveContext", () => ({
  useKitManifestSaveRegistry: () => ({ flushAll: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../lib/persistedSidebarUi", () => ({
  readSidebarCollapsed: () => false,
  writeSidebarCollapsed: vi.fn(),
}));

const stlSync = vi.hoisted(() => ({
  banner: { kind: "hidden" as const } as
    | { kind: "hidden" }
    | { kind: "running" }
    | { kind: "failed" }
    | { kind: "missing"; count: number },
  runSync: vi.fn(),
  busy: false,
}));

vi.mock("../context/StlAutoSyncContext", () => ({
  useStlAutoSync: () => ({
    banner: stlSync.banner,
    runSync: stlSync.runSync,
    busy: stlSync.busy,
    failed: false,
    missingCount: 0,
    emptyThumbCount: 0,
  }),
}));

describe("application shell accessibility", () => {
  beforeEach(() => {
    saveRegistry.registered.clear();
    saveRegistry.saveImportRules.mockReset();
    saveRegistry.flush.mockReset().mockImplementation(async () => {
      await Promise.all([...saveRegistry.registered.values()].map((flush) => flush()));
    });
    workflowState.stages = [];
    workflowState.activeId = null;
    profileState.selectedProfileId = null;
    profileState.profiles = [];
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    cleanup();
    stlSync.banner = { kind: "hidden" };
    stlSync.runSync.mockReset();
    stlSync.busy = false;
    document.documentElement.style.removeProperty("--app-sidebar-width");
    document.documentElement.style.removeProperty("--mobile-stage-height");
  });

  it("puts a skip link before other controls and targets the main landmark", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<h1>Welcome</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const main = screen.getByRole("main");
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    expect(focusable[0]).toBe(skipLink);
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(skipLink.classList.contains("skip-link")).toBe(true);
    expect(main.id).toBe("main-content");
  });

  it("marks the current destination in the mobile nav drawer", async () => {
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="library" element={<h1>Library</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));

    const nav = await screen.findByRole("navigation", { name: "Workshop" });
    expect(nav).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Source Library" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toContain("bg-primary-soft");
    expect(link.className).not.toContain("border-primary");
  });

  it("keeps Source Library off primary-soft when the drawer is opened off-route", async () => {
    render(
      <MemoryRouter initialEntries={["/plan"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="plan" element={<h1>Plan</h1>} />
            <Route path="library" element={<h1>Library</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));

    const link = await screen.findByRole("link", { name: "Source Library" });
    expect(link.getAttribute("aria-current")).toBeNull();
    expect(link.className).not.toContain("bg-primary-soft");
    expect(link.className).not.toContain("border-primary");
    expect(link.className).toContain("border-border");
    expect(link.className).toContain("bg-card");
  });

  it("closes the mobile drawer after a flushed navigation from Sources", async () => {
    render(
      <MemoryRouter initialEntries={["/sources"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="sources" element={<h1>Sources</h1>} />
            <Route path="builds" element={<h1>Builds</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Builds" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Builds" })).toBeTruthy());
    expect(saveRegistry.flush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps Sources open when a mobile drawer save fails", async () => {
    saveRegistry.flush.mockRejectedValueOnce(new Error("offline"));
    render(
      <MemoryRouter initialEntries={["/sources"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="sources" element={<h1>Sources</h1>} />
            <Route path="builds" element={<h1>Builds</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("link", { name: "Builds" }));

    await waitFor(() => expect(saveRegistry.flush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy();
  });

  it("names the current stage and Build in the instrument header", () => {
    workflowState.stages = [{ id: "plan", label: "Plan" }];
    workflowState.activeId = "plan";
    profileState.selectedProfileId = 1;
    profileState.profiles = [{ id: 1, name: "Voron 2.4" }];

    const { container } = render(
      <MemoryRouter initialEntries={["/plan"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="plan" element={<h1>Plan</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const chrome = container.querySelector("header");
    expect(chrome?.textContent).toContain("Plan");
    expect(chrome?.textContent).toContain("Voron 2.4");
    expect(screen.getByRole("main").className).toContain("desk-canvas");
  });

  it("shows the STL sync banner when files are still missing", () => {
    stlSync.banner = { kind: "missing", count: 3 };

    render(
      <MemoryRouter initialEntries={["/plan"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="plan" element={<h1>Plan</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert").textContent).toContain("3 STL missing");
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(stlSync.runSync).toHaveBeenCalledTimes(1);
  });

  it("holds a direct Sources link when saving fails and allows it after retry", async () => {
    saveRegistry.saveImportRules
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ rules: ["latest.stl"] });
    function SourcesEditor() {
      const [pendingRules, setPendingRules] = useState<string[]>([]);
      const [savedRules, setSavedRules] = useState<string[]>([]);
      const { saveUserEdit } = useImportRulesAutosave({
        sourceId: 5,
        pendingRules,
        savedRules,
        rulesLoaded: true,
        userEdited: true,
        disabled: false,
        onSaved: (rules) => setSavedRules(rules),
        onRegisterFlush: (id, flush) => saveRegistry.registered.set(id, flush),
        onUnregisterFlush: (id) => saveRegistry.registered.delete(id),
      });
      return <><h1>Sources</h1><button onClick={() => {
        setPendingRules(["latest.stl"]);
        saveUserEdit(["latest.stl"]);
      }}>Choose file</button><Link to="/plan">Open Plan</Link></>;
    }
    render(
      <MemoryRouter initialEntries={["/sources"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="sources" element={<SourcesEditor />} />
            <Route path="plan" element={<h1>Plan</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(saveRegistry.saveImportRules).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("link", { name: "Open Plan" }));
    await waitFor(() => expect(saveRegistry.flush).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(saveRegistry.saveImportRules).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("link", { name: "Open Plan" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy());
    expect(saveRegistry.saveImportRules).toHaveBeenCalledTimes(3);
  });

  it("uses one API write when the link handler and router blocker both flush", async () => {
    let resolveSave!: (value: { rules: string[] }) => void;
    saveRegistry.saveImportRules.mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    function SourcesEditor() {
      const [pendingRules, setPendingRules] = useState<string[]>([]);
      const [savedRules, setSavedRules] = useState<string[]>([]);
      const { saveUserEdit } = useImportRulesAutosave({
        sourceId: 5,
        pendingRules,
        savedRules,
        rulesLoaded: true,
        userEdited: true,
        disabled: false,
        onSaved: setSavedRules,
        onRegisterFlush: (id, flush) => saveRegistry.registered.set(id, flush),
        onUnregisterFlush: (id) => saveRegistry.registered.delete(id),
      });
      return <><h1>Sources</h1><button onClick={() => {
        setPendingRules(["latest.stl"]);
        saveUserEdit(["latest.stl"]);
      }}>Choose file</button><Link to="/plan">Open Plan</Link></>;
    }
    const router = createMemoryRouter([{
      path: "/",
      element: <><BuildSaveNavigationGuard /><AppLayout /></>,
      children: [
        { path: "sources", element: <SourcesEditor /> },
        { path: "plan", element: <h1>Plan</h1> },
      ],
    }], { initialEntries: ["/sources"] });
    render(<RouterProvider router={router} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(saveRegistry.saveImportRules).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("link", { name: "Open Plan" }));
    expect(router.state.location.pathname).toBe("/sources");
    resolveSave({ rules: ["latest.stl"] });
    await waitFor(() => expect(router.state.location.pathname).toBe("/plan"));
    expect(saveRegistry.flush).toHaveBeenCalledTimes(2);
    expect(saveRegistry.saveImportRules).toHaveBeenCalledTimes(1);
  });
});
