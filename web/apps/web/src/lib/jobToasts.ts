import { toast } from "sonner";
import type { JobSnapshot } from "../api/engine";

export function toastJobResult(
  snap: JobSnapshot,
  successMessage: string,
  failureMessage = "Job failed",
): void {
  if (snap.status === "done") {
    toast.success(successMessage);
    return;
  }
  if (snap.status === "error") {
    toast.error(snap.message || failureMessage);
  }
}
