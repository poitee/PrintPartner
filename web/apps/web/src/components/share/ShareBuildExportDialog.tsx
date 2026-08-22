import { useState } from "react";
import { toast } from "sonner";
import { completeExportDownload } from "../../lib/exportActions";
import { createPlanShare, startExportKitBundle } from "../../api/engine";
import { useAuth } from "../../context/AuthContext";
import { useJobRunner } from "../../hooks/useJobRunner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: number;
};

export default function ShareBuildExportDialog({ open, onOpenChange, profileId }: Props) {
  const { multiUser } = useAuth();
  const exportJob = useJobRunner("kit-export");
  const [tab, setTab] = useState<"file" | "user">("file");
  const [includeProgress, setIncludeProgress] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [sending, setSending] = useState(false);

  const onExport = () => {
    void exportJob.runJob(
      () => startExportKitBundle(profileId, includeProgress),
      (snap) => {
        if (snap.status === "error") {
          toast.error(snap.message || "Export failed");
          return;
        }
        completeExportDownload("Share build", snap.result);
      },
    );
  };

  const onSendToUser = () => {
    setSending(true);
    void createPlanShare(profileId, {
      recipient_email: recipientEmail.trim() || null,
      include_print_progress: includeProgress,
    })
      .then((res) => {
        toast.success(`Sent "${res.plan_name}" — recipient can accept from Shared builds`);
        onOpenChange(false);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share build</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Config only — no STL files. Includes manifest selections, source refs, parts, and
          filament assignments.
        </p>
        {multiUser && (
          <div className="flex gap-2 border-b border-border pb-2">
            <Button
              type="button"
              size="sm"
              variant={tab === "file" ? "default" : "ghost"}
              onClick={() => setTab("file")}
            >
              Export file
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === "user" ? "default" : "ghost"}
              onClick={() => setTab("user")}
            >
              Send to user
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeProgress}
            onChange={(e) => setIncludeProgress(e.target.checked)}
          />
          <span>Include print progress (done/not-done per unit only)</span>
        </label>
        {tab === "user" && multiUser ? (
          <>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">
                Recipient email (optional — leave blank for any signed-in user)
              </span>
              <input
                type="email"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="friend@example.com"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={onSendToUser} disabled={sending}>
                {sending ? "Sending…" : "Send copy"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={onExport} disabled={exportJob.busy}>
              {exportJob.busy ? "Exporting…" : "Export .print-partner-kit"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
