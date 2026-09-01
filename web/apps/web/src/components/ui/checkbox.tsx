import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  /** `shop` gives a 44x44 pointer target for use beside a printer. */
  size?: "default" | "shop";
};

/**
 * The visible box stays small, but a pseudo-element extends the pointer target
 * to at least 24px (WCAG 2.2 target size minimum), or 44px for `shop`. Same
 * technique as `ui/switch`.
 *
 * Pass `checked="indeterminate"` for a tri-state parent; the indicator swaps
 * the tick for a dash, so the third state reads without colour (WCAG G14).
 */
function Checkbox({ className, size = "default", ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative shrink-0 rounded-[4px] border border-input shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        "aria-invalid:border-destructive",
        "before:absolute before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        size === "shop" ? "size-5 before:size-11" : "size-4 before:size-6",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/indicator grid place-content-center text-current"
      >
        <Check
          className={cn(
            "group-data-[state=indeterminate]/indicator:hidden",
            size === "shop" ? "size-4" : "size-3.5",
          )}
          aria-hidden
        />
        <Minus
          className={cn(
            "hidden group-data-[state=indeterminate]/indicator:block",
            size === "shop" ? "size-4" : "size-3.5",
          )}
          aria-hidden
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
