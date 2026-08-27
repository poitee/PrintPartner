import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  /** `shop` gives a 44x44 touch target for use beside a printer. */
  size?: "default" | "shop";
};

/**
 * The visible track stays small, but a pseudo-element extends the pointer
 * target to at least 24px (WCAG 2.2 target size minimum), or 44px for `shop`.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, size = "default", ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      "before:absolute before:inset-x-0 before:top-1/2 before:-translate-y-1/2 before:content-['']",
      size === "shop" ? "h-7 w-12 before:h-11" : "h-5 w-9 before:h-6",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=unchecked]:translate-x-0",
        size === "shop"
          ? "h-6 w-6 data-[state=checked]:translate-x-5"
          : "h-4 w-4 data-[state=checked]:translate-x-4",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
