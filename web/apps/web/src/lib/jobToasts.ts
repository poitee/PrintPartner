import { toast } from "sonner";
import type { JobSnapshot } from "@print-partner/contracts";

export function toastJobResult(
  snap: JobSnapshot,
  successMessage: string,
  failureMessage = "Job failed",
): void {
  if (snap.status === "done") {
    const { failed, synced } = snap.result ?? {};
    if (snap.kind === "sync" && typeof failed === "number" && failed > 0) {
      const count = typeof synced === "number" ? synced : 0;
      toast.warning(`Synced ${count} Source${count === 1 ? "" : "s"}; ${failed} failed.`);
      return;
    }
    toast.success(successMessage);
    return;
  }
  if (snap.status === "error") {
    toast.error(snap.message || failureMessage);
  }
}
