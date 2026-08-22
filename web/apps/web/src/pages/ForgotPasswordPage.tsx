import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
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
import { requestPasswordReset } from "../api/engine";

function isSafeAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export default function ForgotPasswordPage() {
  const { user, multiUser, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);

  if (!loading && !multiUser) {
    return <Navigate to="/" replace />;
  }

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = () => {
    setBusy(true);
    void (async () => {
      try {
        const res = await requestPasswordReset(email);
        setSent(true);
        setDevResetUrl(res.dev_reset_url ?? null);
        toast.success(res.message);
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
            <h1>Reset password</h1>
          </CardTitle>
          <CardDescription>
            {sent
              ? "Check your email for a reset link."
              : "Enter your account email and we will send a reset link."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!sent ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Email</span>
                <input
                  type="email"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
              <Button className="w-full" disabled={busy || !email.trim()} onClick={onSubmit}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              If an account exists for that address, a link was sent. The link expires in one hour.
            </p>
          )}
          {devResetUrl && isSafeAppUrl(devResetUrl) && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-900 dark:text-amber-100">Dev reset link</p>
              <p className="mt-1 break-all text-muted-foreground">
                SMTP is not configured — use this link locally:
              </p>
              <a
                className="mt-2 block break-all text-primary hover:underline"
                href={devResetUrl}
                rel="noopener noreferrer"
              >
                {devResetUrl}
              </a>
            </div>
          )}
          <Link
            to="/login"
            className="block text-center text-sm text-primary hover:underline"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
