import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
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
import { resetPasswordWithToken } from "../api/engine";

export default function ResetPasswordPage() {
  const { multiUser, loading, refresh } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  if (!loading && !multiUser) {
    return <Navigate to="/" replace />;
  }

  if (!loading && !token) {
    return <Navigate to="/forgot-password" replace />;
  }

  const onSubmit = () => {
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await resetPasswordWithToken(token, password);
        await refresh();
        toast.success("Password updated — you are signed in");
        navigate("/", { replace: true });
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
            <h1>Choose a new password</h1>
          </CardTitle>
          <CardDescription>Enter a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">New password</span>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Confirm password</span>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <Button
            className="w-full"
            disabled={busy || password.length < 8 || !confirm}
            onClick={onSubmit}
          >
            {busy ? "Saving…" : "Update password"}
          </Button>
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
