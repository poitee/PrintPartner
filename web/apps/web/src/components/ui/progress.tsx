import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { statusTone, type StatusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type ProgressProps = Omit<
  React.ComponentProps<typeof ProgressPrimitive.Root>,
  "value"
> & {
  /**
   * Percentage complete, or `null` when the work has no measurable total.
   *
   * A null value pulses an empty track rather than inventing a percentage. A
   * made-up number tells the operator a lie about how far along a job is, and
   * Radix correctly drops `aria-valuenow` so a screen reader says "busy"
   * instead of a figure nobody measured.
   */
  value?: number | null;
  tone?: StatusTone;
};

function Progress({ className, value = null, tone = "info", ...props }: ProgressProps) {
  const indeterminate = value == null || !Number.isFinite(value);
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(100, value));

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-indeterminate={indeterminate || undefined}
      value={indeterminate ? null : clamped}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        indeterminate && "motion-safe:animate-pulse",
        className,
      )}
      {...props}
    >
      {indeterminate ? null : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full w-full flex-1 transition-transform",
            statusTone({ tone, emphasis: "solid" }),
          )}
          style={{ transform: `translateX(-${100 - clamped}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  );
}

export { Progress };
