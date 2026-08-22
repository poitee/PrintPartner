// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppLayout from "./AppLayout";

vi.mock("../components/CommandPalette", () => ({ default: () => null }));
vi.mock("../components/JobTray", () => ({ default: () => null }));
vi.mock("../components/PlanTray", () => ({ default: () => null }));
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
vi.mock("../components/PlanPicker", () => ({ default: () => <button type="button">Plan</button> }));
vi.mock("../components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../hooks/useProfileUrlSync", () => ({ useProfileUrlSync: vi.fn() }));
vi.mock("../hooks/useAppUpdateCheck", () => ({ useAppUpdateCheck: () => ({ updateCheck: null }) }));
vi.mock("../hooks/useWorkflowStages", () => ({
  useWorkflowStages: () => ({ stages: [], activeId: null }),
}));
vi.mock("../hooks/useEngineHealth", () => ({ useEngineHealth: () => ({ health: { ok: true } }) }));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: null, profiles: [] }),
}));
vi.mock("../context/ImportRulesSaveContext", () => ({
  useImportRulesSaveRegistry: () => ({ flushAll: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../context/KitManifestSaveContext", () => ({
  useKitManifestSaveRegistry: () => ({ flushAll: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../lib/persistedSidebarUi", () => ({
  readSidebarCollapsed: () => false,
  writeSidebarCollapsed: vi.fn(),
}));

describe("application shell accessibility", () => {
  beforeEach(() => {
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
});
