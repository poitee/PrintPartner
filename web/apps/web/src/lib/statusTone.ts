import { cva, type VariantProps } from "class-variance-authority";
import {
  CircleAlert,
  CircleArrowRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Clock,
  LoaderCircle,
  Lock,
  OctagonAlert,
  Printer,
  RefreshCw,
  TriangleAlert,
  Unplug,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

/**
 * The single source of truth for status presentation.
 *
 * `statusTone` colors a status. `workflowStatusPresentation` turns a workflow
 * state into the tone, the words, and the icon shape that must accompany it —
 * color never carries meaning on its own (WCAG G14). Render it with
 * `components/ui/status-badge`, or read the parts if you need a custom row.
 *
 * Every emphasis works in both themes with no dark: overrides. The dark
 * palette keeps status hues AA-legible as text up to the overlay surface, and
 * solid fills pair with their -foreground inks.
 *
 * emphasis:
 * - text    — icons and inline copy
 * - soft    — chips, banners, status rows (bordered tinted surface)
 * - surface — soft without the ink, for panels whose contents set their own
 *             text colours (cards, worklist rows, tinted list items)
 * - edge    — the border alone, for a card that flags its state on its rim
 *             while keeping a neutral surface behind real content
 * - outline — quiet bordered chip on a transparent background
 * - solid   — progress fills and hard indicators
 */
export const statusTone = cva("", {
  variants: {
    tone: {
      success: "",
      warning: "",
      info: "",
      error: "",
      neutral: "",
    },
    emphasis: {
      text: "",
      soft: "border",
      surface: "border",
      edge: "border",
      outline: "border bg-transparent",
      solid: "",
    },
  },
  compoundVariants: [
    { tone: "success", emphasis: "text", className: "text-success" },
    { tone: "warning", emphasis: "text", className: "text-warning" },
    { tone: "info", emphasis: "text", className: "text-info" },
    { tone: "error", emphasis: "text", className: "text-destructive" },
    { tone: "neutral", emphasis: "text", className: "text-muted-foreground" },

    { tone: "success", emphasis: "soft", className: "border-success/40 bg-success-soft text-success" },
    { tone: "warning", emphasis: "soft", className: "border-warning/40 bg-warning-soft text-warning" },
    { tone: "info", emphasis: "soft", className: "border-info/40 bg-info-soft text-info" },
    { tone: "error", emphasis: "soft", className: "border-destructive/40 bg-destructive-soft text-destructive" },
    { tone: "neutral", emphasis: "soft", className: "border-border bg-muted text-muted-foreground" },

    { tone: "success", emphasis: "surface", className: "border-success/40 bg-success-soft" },
    { tone: "warning", emphasis: "surface", className: "border-warning/40 bg-warning-soft" },
    { tone: "info", emphasis: "surface", className: "border-info/40 bg-info-soft" },
    { tone: "error", emphasis: "surface", className: "border-destructive/40 bg-destructive-soft" },
    { tone: "neutral", emphasis: "surface", className: "border-border bg-muted" },

    { tone: "success", emphasis: "edge", className: "border-success/50" },
    { tone: "warning", emphasis: "edge", className: "border-warning/50" },
    { tone: "info", emphasis: "edge", className: "border-info/50" },
    { tone: "error", emphasis: "edge", className: "border-destructive/50" },
    { tone: "neutral", emphasis: "edge", className: "border-border" },

    { tone: "success", emphasis: "outline", className: "border-success/50 text-success" },
    { tone: "warning", emphasis: "outline", className: "border-warning/50 text-warning" },
    { tone: "info", emphasis: "outline", className: "border-info/50 text-info" },
    { tone: "error", emphasis: "outline", className: "border-destructive/50 text-destructive" },
    { tone: "neutral", emphasis: "outline", className: "border-border-strong text-muted-foreground" },

    { tone: "success", emphasis: "solid", className: "bg-success text-success-foreground" },
    { tone: "warning", emphasis: "solid", className: "bg-warning text-warning-foreground" },
    { tone: "info", emphasis: "solid", className: "bg-info text-info-foreground" },
    { tone: "error", emphasis: "solid", className: "bg-destructive text-destructive-foreground" },
    { tone: "neutral", emphasis: "solid", className: "bg-muted text-muted-foreground" },
  ],
  defaultVariants: { tone: "neutral", emphasis: "soft" },
});

export type StatusTone = NonNullable<VariantProps<typeof statusTone>["tone"]>;
export type StatusEmphasis = NonNullable<VariantProps<typeof statusTone>["emphasis"]>;

/** The workflow states a stage, task, or Build can be in. */
export const WORKFLOW_STATUS_KINDS = [
  "not_started",
  "blocked",
  "ready",
  "in_progress",
  "needs_attention",
  "complete",
  "stale",
  "error",
] as const;

export type WorkflowStatusKind = (typeof WORKFLOW_STATUS_KINDS)[number];

type WorkflowStatusPresentation = Readonly<{
  kind: WorkflowStatusKind;
  tone: StatusTone;
  /** Default words for the state. Pass a more specific label when you have one. */
  label: string;
  /** Distinct shape per state, so the badge reads without color. */
  icon: LucideIcon;
  /**
   * Live-region role for a status that appears while the user is on the page.
   * `alert` is reserved for states the user must handle now.
   */
  live: "status" | "alert" | null;
}>;

const PRESENTATION: Readonly<Record<WorkflowStatusKind, WorkflowStatusPresentation>> = {
  not_started: {
    kind: "not_started",
    tone: "neutral",
    label: "Not started",
    icon: CircleDashed,
    live: null,
  },
  blocked: {
    kind: "blocked",
    tone: "neutral",
    label: "Blocked",
    // A padlock, not a dashed circle: "waiting on something else" must not read
    // as "nobody has started this yet" when the colour is the same (WCAG G14).
    icon: Lock,
    live: null,
  },
  ready: {
    kind: "ready",
    tone: "info",
    label: "Ready",
    icon: CircleArrowRight,
    live: "status",
  },
  in_progress: {
    kind: "in_progress",
    tone: "info",
    label: "In progress",
    icon: LoaderCircle,
    live: "status",
  },
  needs_attention: {
    kind: "needs_attention",
    tone: "warning",
    label: "Needs attention",
    icon: TriangleAlert,
    live: "status",
  },
  complete: {
    kind: "complete",
    tone: "success",
    label: "Complete",
    icon: CircleCheck,
    live: "status",
  },
  stale: {
    kind: "stale",
    tone: "warning",
    label: "Needs refresh",
    icon: RefreshCw,
    live: "status",
  },
  error: {
    kind: "error",
    tone: "error",
    label: "Error",
    icon: CircleAlert,
    live: "alert",
  },
};

/** Tone, words, icon, and live-region role for a workflow state. */
export function workflowStatusPresentation(
  kind: WorkflowStatusKind,
): WorkflowStatusPresentation {
  return PRESENTATION[kind];
}

/**
 * Printer states, as reported by farm status (GRE-1002) and the printer event
 * stream (GRE-1014). `queued` is a job state, not a printer state.
 */
export const PRINTER_STATUS_KINDS = [
  "idle",
  "printing",
  "paused",
  "complete",
  "error",
  "offline",
  "not_connected",
] as const;

export type PrinterStatusKind = (typeof PRINTER_STATUS_KINDS)[number];

type PrinterStatusPresentation = Readonly<{
  kind: PrinterStatusKind;
  label: string;
  /** Distinct shape per state, so the status reads without color. */
  icon: LucideIcon;
  /** Text color from the `--printer-*` tokens. Rebuilt UI only. */
  className: string;
}>;

const PRINTER_PRESENTATION: Readonly<Record<PrinterStatusKind, PrinterStatusPresentation>> = {
  idle: { kind: "idle", label: "Idle", icon: Clock, className: "text-printer-idle" },
  printing: { kind: "printing", label: "Printing", icon: Printer, className: "text-printer-printing" },
  paused: { kind: "paused", label: "Paused", icon: CirclePause, className: "text-printer-paused" },
  complete: { kind: "complete", label: "Complete", icon: CircleCheck, className: "text-printer-complete" },
  error: { kind: "error", label: "Error", icon: OctagonAlert, className: "text-printer-error" },
  offline: { kind: "offline", label: "Offline", icon: WifiOff, className: "text-printer-offline" },
  not_connected: {
    kind: "not_connected",
    label: "Not connected",
    icon: Unplug,
    className: "text-printer-not-connected",
  },
};

/** Words, icon, and token color for a printer state on rebuilt screens. */
export function printerStatusPresentation(kind: PrinterStatusKind): PrinterStatusPresentation {
  return PRINTER_PRESENTATION[kind];
}
