import { type FormEvent, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { useAuth } from "../context/AuthContext";
import { authOAuthUrl } from "../api/engine";

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
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle asChild>
              <h1>Administrator account created</h1>
            </CardTitle>
            <CardDescription>
              Your existing Print Partner data is connected to {createdAccountEmail}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" asChild>
              <Link to={from}>Continue to Print Partner</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            <h1>
              {isFirstRunSetup
                ? "Set up Print Partner"
                : isConfiguredSingleUser
                  ? "Sign in to Print Partner"
                  : "Print Partner"}
            </h1>
          </CardTitle>
          <CardDescription>
            {isFirstRunSetup
              ? "Create the administrator account for this installation. Your existing printers, builds, and settings will stay in place."
              : isConfiguredSingleUser
                ? "This installation already has an administrator account."
                : mode === "login"
                  ? "Sign in to your account"
                  : "Create an account"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            aria-label={mode === "login" ? "Email sign in" : "Email registration"}
            onSubmit={onSubmit}
          >
            {!isFirstRunSetup && <div className="flex flex-col gap-2">
              <Button variant="secondary" asChild>
                <a href={authOAuthUrl("github")}>Continue with GitHub</a>
              </Button>
              <Button variant="secondary" asChild>
                <a href={authOAuthUrl("discord")}>Continue with Discord</a>
              </Button>
            </div>}
            {!isFirstRunSetup && <div className="relative text-center text-xs text-muted-foreground">
              <span className="bg-card px-2">or email</span>
              <div className="absolute inset-x-0 top-1/2 -z-10 border-t border-border" />
            </div>}
            {mode === "register" && (
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Display name</span>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Email</span>
              <input
                type="email"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Password</span>
              <input
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
              />
            </label>
            <Button type="submit" className="w-full" disabled={busy}>
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
            {registrationOpen && !isFirstRunSetup && <button
              type="button"
              className="w-full text-center text-sm text-primary hover:underline"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
            >
              {mode === "login"
                ? "Need an account? Register"
                : "Already have an account? Sign in"}
            </button>}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
