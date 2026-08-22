import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

type Props = {
  title: string;
  /** Small line above the title (e.g. plan name · part count). */
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  icon?: LucideIcon;
  accent?: boolean;
};

export default function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
  icon: Icon,
  accent = false,
}: Props) {
  return (
    <header
      className={cn(
        "relative flex flex-col gap-3 pb-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
        accent && "page-accent-bar pt-1",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          {Icon && (
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent-brand/20 bg-accent-brand/10 text-accent-brand"
              aria-hidden
            >
              <Icon className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
