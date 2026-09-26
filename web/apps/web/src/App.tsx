import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import * as Sentry from "@sentry/react";
import AuthGate from "./components/AuthGate";
import { AuthProvider } from "./context/AuthContext";
import { sentryEnabled } from "./instrument";

const AppRoutes = sentryEnabled ? Sentry.withSentryReactRouterV7Routing(Routes) : Routes;

const AuthenticatedApp = lazy(() => import("./AuthenticatedApp"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));

function PageLoader() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="desk-canvas flex h-dvh items-center justify-center text-body text-muted-foreground"
    >
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageLoader />}>
        <AppRoutes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<AuthGate />}>
            <Route path="*" element={<AuthenticatedApp />} />
          </Route>
        </AppRoutes>
      </Suspense>
    </AuthProvider>
  );
}
