import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import AuthGate from "./components/AuthGate";
import { AuthProvider } from "./context/AuthContext";

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

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<AuthGate />}>
            <Route path="*" element={<AuthenticatedApp />} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
