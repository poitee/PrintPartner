import type { LucideIcon } from "lucide-react";
import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type Props = React.HTMLAttributes<HTMLSpanElement> & {
  variant?:
    | "default"
    | "base"
    | "addon"
    | "muted"
    | "outline"
    | "success"
    | "warning"
    | "error"
    | "info";
  icon?: LucideIcon;
};

/**
 * A label chip. For workflow state use `StatusBadge` instead: it always pairs
 * the color with an icon shape and words.
 */
export function Badge({ className, variant = "default", icon: Icon, children, ...props }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta font-medium tabular transition-colors",
        variant === "default" && "border-primary/40 bg-primary-soft text-primary",
        variant === "base" && statusTone({ tone: "success", emphasis: "soft" }),
        variant === "addon" && statusTone({ tone: "warning", emphasis: "soft" }),
        variant === "muted" && statusTone({ tone: "neutral", emphasis: "soft" }),
        variant === "outline" && "border-border-strong/60 bg-transparent text-foreground",
        variant === "success" && statusTone({ tone: "success", emphasis: "soft" }),
        variant === "warning" && statusTone({ tone: "warning", emphasis: "soft" }),
        variant === "error" && statusTone({ tone: "error", emphasis: "soft" }),
        variant === "info" && statusTone({ tone: "info", emphasis: "soft" }),
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}
