import type { CheckoffRowError } from "../../lib/checkoffConsoleRowErrors";
import { statusTone } from "../../lib/statusTone";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  error: CheckoffRowError;
  onRetry: () => void;
  busy?: boolean;
  className?: string;
};

/**
 * A failed progress mutation stays on the row that broke.
 *
 * A toast is gone before the operator puts the part down. This error waits,
 * and Retry reruns the same operation with the same choices.
 */
export default function CheckoffRowErrorNotice({
  error,
  onRetry,
  busy = false,
  className,
}: Props) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2 text-xs",
        statusTone({ tone: "error", emphasis: "surface" }),
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-destructive">{error.message}</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="min-h-9"
        disabled={busy}
        onClick={onRetry}
      >
        {error.retryLabel}
      </Button>
    </div>
  );
}
