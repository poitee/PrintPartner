import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import AuthScreen, { AuthField } from "../components/auth/AuthScreen";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/AuthContext";
import { resetPasswordWithToken } from "../api/endpoints/auth";

export default function ResetPasswordPage() {
  const { authRequired, loading, refresh } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  if (!loading && !authRequired) {
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
    <AuthScreen
      title="Choose a new password"
      description="Enter a new password for your account."
    >
      <div className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <AuthField label="New password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </AuthField>
          <AuthField label="Confirm password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </AuthField>
          <Button
            type="submit"
            className="w-full"
            size="shop"
            disabled={busy || password.length < 8 || !confirm}
          >
            {busy ? "Saving…" : "Update password"}
          </Button>
        </form>
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
