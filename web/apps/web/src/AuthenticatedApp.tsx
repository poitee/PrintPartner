import { lazy } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { DateFormatProvider } from "./context/DateFormatContext";
import { ImportRulesSaveProvider } from "./context/ImportRulesSaveContext";
import { JobProvider } from "./context/JobContext";
import { KitManifestSaveProvider } from "./context/KitManifestSaveContext";
import { PlanActionsProvider } from "./context/PlanActionsContext";
import { PlanWorkspaceProvider } from "./context/PlanWorkspaceContext";
import { ProfileProvider } from "./context/ProfileContext";
import { SaveStatusProvider } from "./context/SaveStatusContext";
import { StlAutoSyncProvider } from "./context/StlAutoSyncContext";
import AppLayout from "./layout/AppLayout";
import { buildSourcesRoute } from "./lib/routes";

const BuildPage = lazy(() => import("./pages/BuildPage"));
const CheckoffPage = lazy(() => import("./pages/CheckoffPage"));
const ExportPage = lazy(() => import("./pages/ExportPage"));
const GlobalProductionPage = lazy(() => import("./pages/GlobalProductionPage"));
const HelpPage = lazy(() => import("./pages/HelpPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const PartsPage = lazy(() => import("./pages/PartsPage"));
const PlansPage = lazy(() => import("./pages/PlansPage"));
const PrintersPage = lazy(() => import("./pages/PrintersPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SourcesPage = lazy(() => import("./pages/SourcesPage"));

function LegacyStudioRedirect() {
  const { planId } = useParams();
  const id = Number(planId);
  return (
    <Navigate to={buildSourcesRoute(Number.isFinite(id) && id > 0 ? id : null)} replace />
  );
}

function PreserveSearchRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

function IndexRedirect() {
  return <PreserveSearchRedirect to="/builds" />;
}

export default function AuthenticatedApp() {
  return (
    <DateFormatProvider>
      <JobProvider>
        <ProfileProvider>
          <PlanActionsProvider>
            <PlanWorkspaceProvider>
              <StlAutoSyncProvider>
                <SaveStatusProvider>
                  <ImportRulesSaveProvider>
                    <KitManifestSaveProvider>
                      <Routes>
                        <Route element={<AppLayout />}>
                          <Route index element={<IndexRedirect />} />

                          <Route path="library" element={<SourcesPage />} />
                          <Route path="sources" element={<BuildPage />} />
                          <Route
                            path="build"
                            element={<PreserveSearchRedirect to="/sources" />}
                          />

                          <Route path="builds" element={<PlansPage />} />
                          <Route
                            path="plans"
                            element={<PreserveSearchRedirect to="/builds" />}
                          />
                          <Route path="plan" element={<PartsPage />} />
                          <Route
                            path="parts"
                            element={<PreserveSearchRedirect to="/plan" />}
                          />
                          <Route
                            path="review"
                            element={<PreserveSearchRedirect to="/plan" />}
                          />

                          <Route path="progress" element={<CheckoffPage />} />
                          <Route
                            path="checkoff"
                            element={<PreserveSearchRedirect to="/progress" />}
                          />

                          <Route path="production" element={<GlobalProductionPage />} />
                          <Route path="export" element={<ExportPage />} />

                          <Route path="plans/:planId/studio" element={<LegacyStudioRedirect />} />
                          <Route
                            path="plate"
                            element={<PreserveSearchRedirect to="/plan" />}
                          />
                          <Route
                            path="print"
                            element={<PreserveSearchRedirect to="/plan" />}
                          />

                          <Route path="printers" element={<PrintersPage />} />
                          <Route path="settings" element={<SettingsPage />} />
                          <Route path="help" element={<HelpPage />} />
                          <Route path="*" element={<NotFoundPage />} />
                        </Route>
                      </Routes>
                    </KitManifestSaveProvider>
                  </ImportRulesSaveProvider>
                </SaveStatusProvider>
              </StlAutoSyncProvider>
            </PlanWorkspaceProvider>
          </PlanActionsProvider>
        </ProfileProvider>
      </JobProvider>
    </DateFormatProvider>
  );
}
