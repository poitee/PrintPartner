import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { PlanActionsProvider } from "./context/PlanActionsContext";
import { JobProvider } from "./context/JobContext";
import { ProfileProvider } from "./context/ProfileContext";
import { PlanWorkspaceProvider } from "./context/PlanWorkspaceContext";
import { StlAutoSyncProvider } from "./context/StlAutoSyncContext";
import { ImportRulesSaveProvider } from "./context/ImportRulesSaveContext";
import { KitManifestSaveProvider } from "./context/KitManifestSaveContext";
import { SaveStatusProvider } from "./context/SaveStatusContext";
import { AuthProvider } from "./context/AuthContext";
import { DateFormatProvider } from "./context/DateFormatContext";
import AuthGate from "./components/AuthGate";
import AppLayout from "./layout/AppLayout";
import { buildSourcesRoute } from "./lib/routes";

// ─── Lazy page bundles ────────────────────────────────────────────────────────
// Each page is split into its own async chunk so browsers only download what
// they need. three.js (≈500 KB gz) is pulled in only by pages that render
// thumbnails, not on the initial JS payload.
const BuildPage      = lazy(() => import("./pages/BuildPage"));
const CheckoffPage   = lazy(() => import("./pages/CheckoffPage"));
const ExportPage     = lazy(() => import("./pages/ExportPage"));
const GlobalProductionPage = lazy(() => import("./pages/GlobalProductionPage"));
const HelpPage       = lazy(() => import("./pages/HelpPage"));
const LoginPage      = lazy(() => import("./pages/LoginPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const ResetPasswordPage  = lazy(() => import("./pages/ResetPasswordPage"));
const PartsPage      = lazy(() => import("./pages/PartsPage"));
const PlansPage      = lazy(() => import("./pages/PlansPage"));
const PrintersPage   = lazy(() => import("./pages/PrintersPage"));
const SettingsPage   = lazy(() => import("./pages/SettingsPage"));
const SourcesPage    = lazy(() => import("./pages/SourcesPage"));
const NotFoundPage   = lazy(() => import("./pages/NotFoundPage"));

// ─── Minimal page-transition fallback ─────────────────────────────────────────
// Shown only on first load of a chunk — cached chunks render instantly.
function PageLoader() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        opacity: 0.4,
        fontSize: "0.875rem",
        color: "var(--muted-foreground, #6b7280)",
      }}
    >
      Loading…
    </div>
  );
}

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

export default function App() {
  return (
    <AuthProvider>
      <DateFormatProvider>
        <JobProvider>
          <ProfileProvider>
            <PlanActionsProvider>
              <PlanWorkspaceProvider>
                <StlAutoSyncProvider>
                <SaveStatusProvider>
                  <ImportRulesSaveProvider>
                    <KitManifestSaveProvider>
                      <Suspense fallback={<PageLoader />}>
                        <Routes>
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/setup" element={<LoginPage />} />
                        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                        <Route path="/reset-password" element={<ResetPasswordPage />} />
                        <Route element={<AuthGate />}>
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
                        </Route>
                        </Routes>
                      </Suspense>
                    </KitManifestSaveProvider>
                  </ImportRulesSaveProvider>
                </SaveStatusProvider>
                </StlAutoSyncProvider>
              </PlanWorkspaceProvider>
            </PlanActionsProvider>
          </ProfileProvider>
        </JobProvider>
      </DateFormatProvider>
    </AuthProvider>
  );
}
