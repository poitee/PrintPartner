import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import * as Sentry from "@sentry/react";
import AuthGate from "./components/AuthGate";
import { AuthProvider } from "./context/AuthContext";

const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

const AuthenticatedApp = lazy(() => import("./AuthenticatedApp"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));

function ErrorButton() {
  return (
    <button
      type="button"
      onClick={() => {
        throw new Error("This is your first error!");
      }}
      style={{ position: "fixed", right: 16, bottom: 16, zIndex: 50 }}
    >
      Break the world
    </button>
  );
}

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
      <ErrorButton />
      <Suspense fallback={<PageLoader />}>
        <SentryRoutes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<AuthGate />}>
            <Route path="*" element={<AuthenticatedApp />} />
          </Route>
        </SentryRoutes>
      </Suspense>
    </AuthProvider>
  );
}
