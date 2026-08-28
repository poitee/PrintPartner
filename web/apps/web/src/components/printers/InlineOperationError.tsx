import { CircleAlert } from "lucide-react";
import { Button } from "../ui/button";
import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type Props = {
  /** What failed, in the operator's words. Not the raw error. */
  title: string;
  /** The detail behind the failure, usually the server's message. */
  message: string;
  /** Reruns the operation that failed, with the operator's choices intact. */
  onRetry: () => void;
  retryLabel?: string;
  /** True while the retry is running. */
  busy?: boolean;
  className?: string;
};

/**
 * A recoverable failure that stays on screen until it is dealt with.
 *
 * A toast is gone before an operator standing beside a printer has read it, and
 * it takes the Retry with it. So every failure in this workspace becomes a block
 * that keeps both the reason and the button that fixes it.
 */
export default function InlineOperationError({
  title,
  message,
  onRetry,
  retryLabel = "Retry",
  busy = false,
  className,
}: Props) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-md px-3 py-2.5",
        statusTone({ tone: "error", emphasis: "soft" }),
        className,
      )}
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="text-meta">{message}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="min-h-11 shrink-0"
        loading={busy}
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  );
}
