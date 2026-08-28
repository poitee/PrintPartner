import type { PrinterCheckoffLinkState } from "@print-partner/contracts";
import type { WorkflowStatusKind } from "@/lib/statusTone";

/**
 * A tracked print's state as words plus a workflow status.
 *
 * The raw state names are database values. `link.state.replaceAll("_", " ")`
 * used to reach the operator as "awaiting verify", which is not English and
 * carries no tone, so the words and the icon come from here and the colour
 * comes from `lib/statusTone` through `StatusBadge`.
 */
export type TrackedPrintPresentation = Readonly<{
  status: WorkflowStatusKind;
  label: string;
  /** True when only the operator can move this print forward. */
  awaitingOperator: boolean;
}>;

export function trackedPrintPresentation(input: {
  state: PrinterCheckoffLinkState;
  /** True when no host reports on this print, so the operator finishes it. */
  manual: boolean;
}): TrackedPrintPresentation {
  switch (input.state) {
    case "watching":
      return input.manual
        ? {
            status: "needs_attention",
            label: "Waiting for you to mark it finished",
            awaitingOperator: true,
          }
        : { status: "in_progress", label: "Watching this printer", awaitingOperator: false };
    case "awaiting_verify":
      return { status: "needs_attention", label: "Ready for Checkoff", awaitingOperator: true };
    case "host_failed":
      return { status: "error", label: "The printer reported a failure", awaitingOperator: true };
    case "dismissed":
      return { status: "not_started", label: "Dismissed", awaitingOperator: false };
    case "verified":
      return { status: "complete", label: "Verified in Checkoff", awaitingOperator: false };
    case "applied":
      return { status: "complete", label: "Checked off", awaitingOperator: false };
    default: {
      const _exhaustive: never = input.state;
      return _exhaustive;
    }
  }
}
