import { type MouseEvent, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import CommandPalette from "../components/CommandPalette";
import ErrorBoundary from "../components/ErrorBoundary";
import JobTray from "../components/JobTray";
import SupportCta from "../components/SupportCta";
import { Toaster } from "../components/ui/sonner";
import SaveStatusIndicator from "../components/SaveStatusIndicator";
import UserMenu from "../components/UserMenu";
import WorkflowProgress from "../components/WorkflowProgress";
import SpineRail from "../components/layout/SpineRail";
import MobileNavDrawer from "../components/layout/MobileNavDrawer";
import UpdateAvailableBanner, {
  dismissUpdateBanner,
  isUpdateBannerDismissed,
} from "../components/UpdateAvailableBanner";
import { useProfileUrlSync } from "../hooks/useProfileUrlSync";
import { useAppUpdateCheck } from "../hooks/useAppUpdateCheck";
import { useWorkflowStages } from "../hooks/useWorkflowStages";
import {
  isBuildPath,
  isExportPath,
  isPartsPath,
  isProgressPath,
  isSourcesPath,
} from "../lib/routes";
import { cn } from "@/lib/utils";
import { useProfileSelection } from "../context/ProfileContext";
import { useImportRulesSaveRegistry } from "../context/ImportRulesSaveContext";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";
import ThemePreferenceControl from "../components/ThemePreferenceControl";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { readSidebarCollapsed, writeSidebarCollapsed } from "../lib/persistedSidebarUi";
import { TooltipProvider } from "../components/ui/tooltip";

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { health } = useEngineHealth();
  const { updateCheck } = useAppUpdateCheck(Boolean(health));
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };

  useEffect(() => {
    if (updateCheck?.latest_version) {
      setBannerDismissed(isUpdateBannerDismissed(updateCheck.latest_version));
    }
  }, [updateCheck?.latest_version]);

  useEffect(() => {
    const width = sidebarCollapsed ? "4.25rem" : "14rem";
    document.documentElement.style.setProperty("--app-sidebar-width", width);
  }, [sidebarCollapsed]);

  // One persistent mobile navigation row. Its height is published so the job
  // strip and page padding can clear it without hard-coded guesses.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => {
      document.documentElement.style.setProperty(
        "--mobile-stage-height",
        mq.matches ? "0px" : "4rem",
      );
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const onDismissUpdateBanner = () => {
    if (!updateCheck?.latest_version) return;
    dismissUpdateBanner(updateCheck.latest_version);
    setBannerDismissed(true);
  };

  useProfileUrlSync();
  const { selectedProfileId, profiles } = useProfileSelection();
  const { flushAll: flushImportRules } = useImportRulesSaveRegistry();
  const { flushAll: flushKitManifest } = useKitManifestSaveRegistry();
  const { stages, activeId } = useWorkflowStages();

  const onPipelineNavigate = (to: string, e: MouseEvent<HTMLAnchorElement>) => {
    const destPath = to.split("?")[0] ?? to;
    const leavingSources = isSourcesPath(location.pathname) && !isSourcesPath(destPath);
    if (!leavingSources) return;
    e.preventDefault();
    void Promise.all([flushImportRules(), flushKitManifest()]).then(() => {
      navigate(to);
    });
  };

  const activePlanName =
    selectedProfileId != null
      ? profiles.find((p) => p.id === selectedProfileId)?.name
      : null;

  const showPlanInHeader =
    activePlanName &&
    (isBuildPath(location.pathname) ||
      isPartsPath(location.pathname) ||
      isProgressPath(location.pathname) ||
      isExportPath(location.pathname));

  return (
    <TooltipProvider delayDuration={300}>
        <div className="flex min-h-screen min-w-0 bg-background">
          <a
            href="#main-content"
            className="skip-link"
          >
            Skip to main content
          </a>
          <SpineRail
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            stages={stages}
            activeId={activeId}
            onStageNavigate={onPipelineNavigate}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2.5 sm:gap-4 sm:px-5 print:hidden"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <MobileNavDrawer onNavigate={onPipelineNavigate} />
                {showPlanInHeader && activePlanName ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    <span className="font-medium text-foreground">{activePlanName}</span>
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center gap-2 sm:justify-end">
                <SaveStatusIndicator />
                <SupportCta variant="secondary" size="sm" className="hidden shrink-0 sm:inline-flex" />
                <ThemePreferenceControl compact className="hidden shrink-0 md:inline-flex" />
                <UserMenu />
              </div>
            </header>

            <main
              id="main-content"
              tabIndex={-1}
              className={cn(
                "flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-5 print:overflow-visible print:p-0",
                // Reserve the fixed chrome so a running job or the mobile nav row
                // never covers the end of the page.
                "pb-[calc(var(--mobile-stage-height,0px)+var(--job-tray-height,0px)+2rem)]",
              )}
            >
              <ErrorBoundary key={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </main>

            <WorkflowProgress
              variant="mobile"
              stages={stages}
              activeId={activeId}
              onNavigate={onPipelineNavigate}
              className="fixed bottom-0 left-0 right-0 z-30 lg:hidden"
            />

            {updateCheck && (
              <UpdateAvailableBanner
                updateCheck={updateCheck}
                dismissed={bannerDismissed}
                onDismiss={onDismissUpdateBanner}
              />
            )}
          </div>

          <JobTray sidebarCollapsed={sidebarCollapsed} />
          <CommandPalette />
          <Toaster position="bottom-right" richColors closeButton />
        </div>
    </TooltipProvider>
  );
}
