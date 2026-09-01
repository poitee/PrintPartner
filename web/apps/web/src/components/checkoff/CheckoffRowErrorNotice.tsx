import type { CheckoffRowError } from "../../lib/checkoffConsoleRowErrors";
import { Alert, AlertActions, AlertTitle } from "../ui/alert";
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
    <Alert tone="error" className={cn("px-2.5 py-2 text-xs", className)}>
      <AlertTitle className="font-normal">{error.message}</AlertTitle>
      <AlertActions>
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
      </AlertActions>
    </Alert>
  );
}
