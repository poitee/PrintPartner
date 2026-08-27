import { useState } from "react";
import LayeredSheetMark from "../components/layout/BrandMark";
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
import { requestPasswordReset } from "../api/endpoints/auth";
import { isSafeAppUrl } from "../lib/authPageModel";

export default function ForgotPasswordPage() {
  const { user, authRequired, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);

  if (!loading && !authRequired) {
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="flex items-center gap-2.5" aria-hidden>
        <LayeredSheetMark />
        <span className="font-serif text-[17px] font-semibold tracking-[-0.01em] text-foreground">
          Print Partner
        </span>
      </div>
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
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
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
              <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              If an account exists for that address, a link was sent. The link expires in one hour.
            </p>
          )}
          {devResetUrl && isSafeAppUrl(devResetUrl) && (
            <div className="rounded-md border border-warning/30 bg-warning-soft p-3 text-sm">
              <p className="font-medium text-warning">Dev reset link</p>
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
    </main>
  );
}
