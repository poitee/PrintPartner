import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { statusTone, type StatusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

/**
 * A banner that stays on screen until the reason for it is gone.
 *
 * Colour comes from `lib/statusTone` — the one status vocabulary — so a warning
 * banner and a warning chip are the same warning. Pair the tone with an icon and
 * words; colour never carries the meaning on its own (WCAG G14).
 *
 * Layout is a grid: an optional leading `<svg>`, the title and description, and
 * an optional `AlertActions` pinned to the trailing edge.
 */
const alertVariants = cva(
  cn(
    "relative grid w-full items-start gap-y-0.5 rounded-lg px-3 py-2.5 text-sm",
    "grid-cols-[0_1fr]",
    "has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3",
    "has-[>[data-slot=alert-actions]]:grid-cols-[0_1fr_auto] has-[>[data-slot=alert-actions]]:gap-x-3",
    "has-[>svg]:has-[>[data-slot=alert-actions]]:grid-cols-[calc(var(--spacing)*4)_1fr_auto]",
    "[&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  ),
  {
    variants: {
      tone: {
        success: statusTone({ tone: "success", emphasis: "soft" }),
        warning: statusTone({ tone: "warning", emphasis: "soft" }),
        info: statusTone({ tone: "info", emphasis: "soft" }),
        error: statusTone({ tone: "error", emphasis: "soft" }),
        // Neutral keeps full-strength ink on the title so a quiet banner still
        // has a readable headline.
        neutral: cn(
          statusTone({ tone: "neutral", emphasis: "soft" }),
          "[&_[data-slot=alert-title]]:text-foreground",
        ),
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

type AlertProps = React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    tone?: StatusTone;
  };

function Alert({ className, tone, ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      data-tone={tone ?? "neutral"}
      role="alert"
      className={cn(alertVariants({ tone }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm opacity-90 [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Buttons for the banner, on the trailing edge and vertically centred.
 * `col-end-[-1]` puts them in the last column whether or not there is an icon.
 */
function AlertActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-actions"
      className={cn(
        "col-end-[-1] row-start-1 row-span-full flex shrink-0 flex-wrap items-center gap-2 self-center",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertActions };
