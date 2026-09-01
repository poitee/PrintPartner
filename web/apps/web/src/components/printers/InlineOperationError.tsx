import { CircleAlert } from "lucide-react";
import { Button } from "../ui/button";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "../ui/alert";

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
 *
 * It is `ui/alert` in its error tone: the icon, the colour and the trailing
 * action column all come from the one banner primitive, so this block and every
 * other status banner stay the same shape.
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
    <Alert tone="error" className={className}>
      <CircleAlert aria-hidden />
      <AlertTitle className="text-body">{title}</AlertTitle>
      <AlertDescription className="text-meta">{message}</AlertDescription>
      <AlertActions>
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
      </AlertActions>
    </Alert>
  );
}
