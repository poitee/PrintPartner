import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Where the card sits on the surface ladder.
   * - `raised` (default) — the normal panel on a page.
   * - `flat` — a grouped block that must not compete with a raised card.
   * - `sunken` — a well inside a raised card (previews, read-only detail).
   */
  surface?: "raised" | "flat" | "sunken";
  /** Hover feedback. Use only when the whole card is a link or a button. */
  interactive?: boolean;
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, surface = "raised", interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      data-surface={surface}
      className={cn(
        "rounded-lg border border-border text-card-foreground",
        // A raised card inside a raised card keeps its own edge readable.
        surface === "raised" &&
          "bg-card shadow-sm [[data-surface=raised]_&]:border-border-strong/50 [[data-surface=raised]_&]:shadow-none",
        surface === "flat" && "bg-transparent",
        surface === "sunken" && "bg-surface-sunken",
        interactive &&
          "transition-[box-shadow,border-color] hover:border-border-strong/60 hover:shadow-md",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

type CardHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  accent?: boolean;
};

const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, accent, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-1.5 p-4",
        accent && "rounded-t-lg border-b border-border bg-surface-sunken/70",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  asChild?: boolean;
  level?: 2 | 3 | 4 | 5 | 6;
};

const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ asChild = false, className, level = 2, ...props }, ref) => {
    const Component: React.ElementType = asChild ? Slot : `h${level}`;
    return (
      <Component
        ref={ref}
        className={cn("text-title font-semibold tracking-tight", className)}
        {...props}
      />
    );
  },
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-wrap items-center gap-2 p-4 pt-0", className)}
      {...props}
    />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
