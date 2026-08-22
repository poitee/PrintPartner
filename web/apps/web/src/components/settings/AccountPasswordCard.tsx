import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { changePassword } from "../../api/engine";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

export default function AccountPasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = () => {
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await changePassword(currentPassword, newPassword);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        toast.success("Password updated");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle level={3} className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden />
          Account password
        </CardTitle>
        <CardDescription>Change your sign-in password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Current password</span>
          <input
            type="password"
            className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">New password</span>
          <input
            type="password"
            className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Confirm new password</span>
          <input
            type="password"
            className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <Button
          disabled={busy || !currentPassword || newPassword.length < 8 || !confirmPassword}
          onClick={onSubmit}
        >
          {busy ? "Saving…" : "Update password"}
        </Button>
      </CardContent>
    </Card>
  );
}
