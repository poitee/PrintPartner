import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { toast } from "sonner";
import AuthScreen, { AuthField } from "../components/auth/AuthScreen";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/AuthContext";
import { requestPasswordReset } from "../api/endpoints/auth";
import { isSafeAppUrl } from "../lib/authPageModel";
import { statusTone } from "../lib/statusTone";
import { cn } from "@/lib/utils";

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
    <AuthScreen
      title="Reset password"
      description={
        sent
          ? "Check your email for a reset link."
          : "Enter your account email and we will send a reset link."
      }
    >
      <div className="space-y-4">
        {!sent ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <AuthField label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </AuthField>
            <Button
              type="submit"
              className="w-full"
              size="shop"
              disabled={busy || !email.trim()}
            >
              {busy ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            If an account exists for that address, a link was sent. The link expires in one hour.
          </p>
        )}
        {devResetUrl && isSafeAppUrl(devResetUrl) && (
          <div
            className={cn(
              "rounded-md p-3 text-sm",
              statusTone({ tone: "warning", emphasis: "surface" }),
            )}
          >
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
      </div>
    </AuthScreen>
  );
}
