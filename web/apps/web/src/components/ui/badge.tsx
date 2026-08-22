import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

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

export function Badge({ className, variant = "default", icon: Icon, children, ...props }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
        variant === "default" && "border border-primary/30 bg-primary/15 text-primary",
        variant === "base" && "border border-success/25 bg-success/15 text-success",
        variant === "addon" && "border border-warning/25 bg-warning/15 text-warning",
        variant === "muted" && "border border-border bg-muted text-muted-foreground",
        variant === "outline" && "border border-border bg-transparent text-foreground",
        variant === "success" && "border border-success/30 bg-success/15 text-success",
        variant === "warning" && "border border-warning/30 bg-warning/15 text-warning",
        variant === "error" && "border border-destructive/30 bg-destructive/15 text-destructive",
        variant === "info" && "border border-info/30 bg-info/15 text-info",
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}
