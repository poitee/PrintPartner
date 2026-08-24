import { cva, type VariantProps } from "class-variance-authority";

/**
 * Status coloring built on the theme's semantic tokens. Every emphasis works
 * in both themes with no dark: overrides — the dark palette keeps status hues
 * AA-legible as text, and solid fills pair with their -foreground inks.
 *
 * emphasis:
 * - text    — icons and inline copy
 * - soft    — chips, banners, status rows (bordered tinted surface)
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

    { tone: "success", emphasis: "soft", className: "border-success/30 bg-success-soft text-success" },
    { tone: "warning", emphasis: "soft", className: "border-warning/30 bg-warning-soft text-warning" },
    { tone: "info", emphasis: "soft", className: "border-info/30 bg-info-soft text-info" },
    { tone: "error", emphasis: "soft", className: "border-destructive/30 bg-destructive-soft text-destructive" },
    { tone: "neutral", emphasis: "soft", className: "border-border bg-muted text-muted-foreground" },

    { tone: "success", emphasis: "outline", className: "border-success/40 text-success" },
    { tone: "warning", emphasis: "outline", className: "border-warning/40 text-warning" },
    { tone: "info", emphasis: "outline", className: "border-info/40 text-info" },
    { tone: "error", emphasis: "outline", className: "border-destructive/40 text-destructive" },
    { tone: "neutral", emphasis: "outline", className: "border-border text-muted-foreground" },

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
