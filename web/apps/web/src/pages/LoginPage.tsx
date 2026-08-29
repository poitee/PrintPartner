import { type FormEvent, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import AuthScreen, { AuthField } from "../components/auth/AuthScreen";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/AuthContext";
import { authOAuthUrl } from "../api/endpoints/auth";

export default function LoginPage() {
  const { user, multiUser, authRequired, registrationOpen, loading, loginEmail, registerEmail } = useAuth();
  const location = useLocation();
  const isFirstRunSetup = !multiUser && registrationOpen;
  const [mode, setMode] = useState<"login" | "register">(() =>
    isFirstRunSetup ? "register" : "login",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdAccountEmail, setCreatedAccountEmail] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const isConfiguredSingleUser = !multiUser && authRequired && !registrationOpen;

  if (!loading && !authRequired) {
    return <Navigate to="/" replace />;
  }

  if (createdAccountEmail) {
    return (
      <AuthScreen
        title="Administrator account created"
        description={
          <>Your existing Print Partner data is connected to {createdAccountEmail}.</>
        }
      >
        <Button className="w-full" size="shop" asChild>
          <Link to={from}>Continue to Print Partner</Link>
        </Button>
      </AuthScreen>
    );
  }

  if (!loading && user) {
    return <Navigate to={from} replace />;
  }

  if (!loading && location.pathname === "/setup" && isConfiguredSingleUser) {
    return <Navigate to="/login" replace state={location.state} />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    void (async () => {
      try {
        if (mode === "login") {
          await loginEmail(email, password);
        } else {
          await registerEmail(email, password, displayName);
          setCreatedAccountEmail(email);
        }
        if (mode === "login") toast.success("Signed in");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const title = isFirstRunSetup
    ? "Set up Print Partner"
    : isConfiguredSingleUser
      ? "Sign in to Print Partner"
      : "Print Partner";

  const description = isFirstRunSetup
    ? "Create the administrator account for this installation. Your existing printers, builds, and settings will stay in place."
    : isConfiguredSingleUser
      ? "This installation already has an administrator account."
      : mode === "login"
        ? "Sign in to your account"
        : "Create an account";

  return (
    <AuthScreen title={title} description={description}>
      <form
        className="space-y-4"
        aria-label={mode === "login" ? "Email sign in" : "Email registration"}
        onSubmit={onSubmit}
      >
        {!isFirstRunSetup && (
          <div className="flex flex-col gap-2">
            <Button variant="secondary" asChild>
              <a href={authOAuthUrl("github")}>Continue with GitHub</a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={authOAuthUrl("discord")}>Continue with Discord</a>
            </Button>
          </div>
        )}
        {!isFirstRunSetup && (
          <div className="relative text-center text-xs text-muted-foreground">
            <span className="bg-card px-2">or email</span>
            <div className="absolute inset-x-0 top-1/2 -z-10 border-t border-border" />
          </div>
        )}
        {mode === "register" && (
          <AuthField label="Display name">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              required
            />
          </AuthField>
        )}
        <AuthField label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </AuthField>
        <AuthField label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </AuthField>
        <Button type="submit" className="w-full" size="shop" disabled={busy}>
          {busy
            ? "Please wait…"
            : mode === "login"
              ? "Sign in"
              : isFirstRunSetup
                ? "Create administrator"
                : "Create account"}
        </Button>
        {mode === "login" && (
          <Link
            to="/forgot-password"
            className="block text-center text-sm text-muted-foreground hover:text-primary hover:underline"
          >
            Forgot password?
          </Link>
        )}
        {registrationOpen && !isFirstRunSetup && (
          <button
            type="button"
            className="w-full text-center text-sm text-primary hover:underline"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login"
              ? "Need an account? Register"
              : "Already have an account? Sign in"}
          </button>
        )}
      </form>
    </AuthScreen>
  );
}
