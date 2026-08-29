import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function AuthGate() {
  const { user, multiUser, authRequired, registrationOpen, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="desk-canvas flex min-h-dvh items-center justify-center text-body text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (authRequired && !user) {
    return (
      <Navigate
        to={!multiUser && registrationOpen ? "/setup" : "/login"}
        replace
        state={{ from: location.pathname + location.search + location.hash }}
      />
    );
  }

  return <Outlet />;
}
