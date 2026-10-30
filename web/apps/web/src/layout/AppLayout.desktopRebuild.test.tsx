// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { TENANT_FEATURE_TOGGLES_CAPABILITY } from "@print-partner/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppLayout from "./AppLayout";
import { DESKTOP_REBUILD_ATTRIBUTE } from "../lib/desktopRebuild";

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
const healthState = vi.hoisted(() => ({
  health: { ok: true } as { ok: boolean; capabilities?: string[] } | null,
}));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: healthState.health }) }));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => profileState,
}));
const saveRegistry = vi.hoisted(() => ({
  flush: vi.fn(),
  registered: new Map<number, () => Promise<void>>(),
}));
vi.mock("../context/BuildSaveFlushContext", () => ({
  useFlushBuildPageSaves: () => saveRegistry.flush,
  useBuildSaveFlushRegistry: () => (id: number, flush: () => Promise<void>) => {
    saveRegistry.registered.set(id, flush);
    return () => saveRegistry.registered.delete(id);
  },
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

function shell() {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<h1>Welcome</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

/** The existing shell already writes CSS variables to the root `style`. */
function rootAttributes(): string[] {
  return document.documentElement.getAttributeNames().filter((name) => name !== "style").sort();
}

describe("desktop rebuild app shell", () => {
  beforeEach(() => {
    healthState.health = { ok: true };
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
    document.documentElement.removeAttribute(DESKTOP_REBUILD_ATTRIBUTE);
    document.documentElement.style.removeProperty("--app-sidebar-width");
    document.documentElement.style.removeProperty("--mobile-stage-height");
  });

  it.each([
    ["health not loaded", null],
    ["no capabilities", { ok: true }],
    ["other capabilities", { ok: true, capabilities: ["jobs_ws", "logging"] }],
  ])("leaves the root untouched with the flag off (%s)", (_name, health) => {
    healthState.health = health;
    const before = rootAttributes();
    render(shell());
    expect(document.documentElement.hasAttribute(DESKTOP_REBUILD_ATTRIBUTE)).toBe(false);
    expect(rootAttributes()).toEqual(before);
  });

  it("marks the root while the flag is on and clears it when the flag turns off", () => {
    healthState.health = { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] };
    const view = render(shell());
    expect(document.documentElement.getAttribute(DESKTOP_REBUILD_ATTRIBUTE)).toBe("");

    healthState.health = { ok: true, capabilities: [] };
    view.rerender(shell());
    expect(document.documentElement.hasAttribute(DESKTOP_REBUILD_ATTRIBUTE)).toBe(false);
  });

  it("clears the root marker when the shell unmounts", () => {
    healthState.health = { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] };
    const view = render(shell());
    view.unmount();
    expect(document.documentElement.hasAttribute(DESKTOP_REBUILD_ATTRIBUTE)).toBe(false);
  });

  it("renders the same shell markup with the flag on and off", () => {
    const off = render(shell()).container.innerHTML;
    cleanup();
    healthState.health = { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] };
    const on = render(shell()).container.innerHTML;
    expect(on).toBe(off);
  });
});
