import type { ReactNode } from "react";
import {
  statusTone,
  workflowStatusPresentation,
  type StatusEmphasis,
  type WorkflowStatusKind,
} from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type Props = {
  /** Workflow state. Drives the tone, the icon shape, and the default words. */
  status: WorkflowStatusKind;
  /** More specific words than the default, e.g. "2 jobs printing". */
  label?: ReactNode;
  /** Chip fill. `text` drops the chip and keeps the icon + words inline. */
  emphasis?: Extract<StatusEmphasis, "soft" | "outline" | "text">;
  size?: "sm" | "md";
  /**
   * Announce the status when it appears or changes. Uses the role the state
   * asks for: polite `status` for progress, `alert` only for errors.
   */
  live?: boolean;
  className?: string;
};

/**
 * A status chip that always shows an icon shape and text, so color is never
 * the only carrier of meaning (WCAG G14). Read tones and labels from
 * `lib/statusTone` rather than writing color classes by hand.
 */
export function StatusBadge({
  status,
  label,
  emphasis = "soft",
  size = "md",
  live = false,
  className,
}: Props) {
  const presentation = workflowStatusPresentation(status);
  const Icon = presentation.icon;
  const role = live && presentation.live ? presentation.live : undefined;

  return (
    <span
      role={role}
      data-status={status}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 font-medium",
        emphasis === "text" ? "gap-1" : "rounded-full border",
        size === "sm" ? "text-micro" : "text-meta",
        emphasis !== "text" && (size === "sm" ? "px-1.5 py-0.5" : "px-2 py-0.5"),
        statusTone({ tone: presentation.tone, emphasis }),
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "shrink-0",
          size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5",
          status === "in_progress" && "motion-safe:animate-spin",
        )}
      />
      <span className="truncate">{label ?? presentation.label}</span>
    </span>
  );
}
