import { Check, Loader2, AlertCircle } from "lucide-react";
import { useSaveStatusRegistry } from "../context/SaveStatusContext";
import { cn } from "../lib/utils";

export default function SaveStatusIndicator() {
  const { entries } = useSaveStatusRegistry();
  const active = entries.filter((e) => e.status !== "idle");
  if (active.length === 0) return null;

  const saving = active.some((e) => e.status === "saving");
  const errored = active.find((e) => e.status === "error");
  const saved = active.every((e) => e.status === "saved");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
        errored
          ? "bg-destructive/10 text-destructive"
          : saving
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
      role="status"
      aria-live="polite"
    >
      {saving ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : errored ? (
        <AlertCircle className="h-3 w-3" aria-hidden />
      ) : saved ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : null}
      <span className="max-w-[140px] truncate">
        {errored
          ? errored.error ?? "Save failed"
          : saving
            ? "Saving…"
            : "Saved"}
      </span>
    </span>
  );
}
