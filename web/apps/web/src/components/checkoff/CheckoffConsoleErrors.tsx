import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type Props = {
  profilesError: string | null;
  reviewError: string | null;
  auxiliaryError: string | null;
  /** One entry per row whose last change failed. Retry lives on the row. */
  rowErrors: { key: string; message: string }[];
  className?: string;
};

/**
 * Page-level error summary.
 *
 * GOV.UK pairs a summary with the inline message beside each problem. The
 * summary tells the operator how many changes did not save; the row keeps the
 * Retry that fixes it.
 */
export default function CheckoffConsoleErrors({
  profilesError,
  reviewError,
  auxiliaryError,
  rowErrors,
  className,
}: Props) {
  const hasAny =
    Boolean(profilesError) ||
    Boolean(reviewError) ||
    Boolean(auxiliaryError) ||
    rowErrors.length > 0;
  if (!hasAny) return null;

  return (
    <div className={cn("space-y-1", className)}>
      {profilesError ? (
        <p className="text-sm text-destructive" role="alert">
          Could not refresh plans: {profilesError}
        </p>
      ) : null}
      {reviewError ? (
        <p className="text-sm text-destructive" role="alert">
          Could not refresh Checkoff: {reviewError}
        </p>
      ) : null}
      {auxiliaryError ? (
        <p className="text-sm text-destructive" role="alert">
          {auxiliaryError}
        </p>
      ) : null}
      {rowErrors.length > 0 ? (
        <div
          className={cn(
            "rounded-md p-3",
            statusTone({ tone: "error", emphasis: "surface" }),
          )}
          role="alert"
        >
          <p className="text-sm font-semibold text-destructive">
            {rowErrors.length === 1
              ? "1 change did not save"
              : `${rowErrors.length} changes did not save`}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-destructive">
            {rowErrors.map((entry) => (
              <li key={entry.key}>{entry.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
