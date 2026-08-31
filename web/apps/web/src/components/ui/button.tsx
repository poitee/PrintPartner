import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Spinner } from "./spinner";
import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

/**
 * Sizes. Every size clears the WCAG 2.2 minimum target of 24x24 CSS px.
 * Use `shop` / `shopIcon` (44x44) for the primary action on a page an
 * operator uses beside a printer.
 */
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 rounded-md text-sm font-medium transition-[color,background-color,box-shadow,border-color] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow-md",
        secondary:
          "border border-border-strong bg-secondary text-secondary-foreground shadow-sm hover:border-primary/40 hover:bg-accent hover:text-accent-foreground",
        ghost: "text-foreground hover:bg-accent/80 hover:text-accent-foreground",
        outline:
          "border border-border-strong bg-background shadow-sm hover:border-primary/50 hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        destructive: cn(
          statusTone({ tone: "error", emphasis: "edge" }),
          "bg-destructive-soft text-destructive hover:bg-destructive/20",
        ),
        info: "bg-info text-info-foreground shadow-sm hover:bg-info/90 hover:shadow-md",
        sheetRemove:
          "border border-[var(--paper-destructive-border)] bg-[var(--paper-bg)] text-[var(--paper-destructive)] shadow-none hover:border-[var(--paper-destructive-border-hover)] hover:bg-[var(--paper-destructive-bg-hover)] hover:text-[var(--paper-destructive-hover)]",
        sheetRestore:
          "border border-[var(--paper-border)] bg-[var(--paper-bg)] text-[var(--paper-muted-fg)] shadow-none hover:border-[var(--paper-border-strong)] hover:bg-[var(--paper-surface-hover)] hover:text-[var(--paper-fg)]",
      },
      size: {
        default: "h-9 min-w-9 px-4 py-2",
        sm: "h-8 min-w-8 rounded-md px-3 text-xs",
        lg: "h-10 min-w-10 rounded-md px-6",
        icon: "h-9 w-9",
        /** Shop floor: 44x44 per Apple's touch guidance. */
        shop: "h-11 min-w-11 rounded-md px-5 text-base",
        shopIcon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ref,
  ...props
}: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (asChild) {
    return (
      <Slot
        className={classes}
        {...props}
        aria-busy={loading || undefined}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" aria-hidden />}
      {children}
    </button>
  );
}
