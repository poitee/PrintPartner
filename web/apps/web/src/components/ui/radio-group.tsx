import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

type RadioGroupItemProps = React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
  /** `shop` gives a 44x44 pointer target for use beside a printer. */
  size?: "default" | "shop";
};

/**
 * The visible dot stays small, but a pseudo-element extends the pointer target
 * to at least 24px (WCAG 2.2 target size minimum), or 44px for `shop`.
 */
function RadioGroupItem({ className, size = "default", ...props }: RadioGroupItemProps) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "relative aspect-square shrink-0 rounded-full border border-input text-primary shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-primary",
        "aria-invalid:border-destructive",
        "before:absolute before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        size === "shop" ? "size-5 before:size-11" : "size-4 before:size-6",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex h-full w-full items-center justify-center"
      >
        <span
          className={cn(
            "block rounded-full bg-primary",
            size === "shop" ? "size-2.5" : "size-2",
          )}
        />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
