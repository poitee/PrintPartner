import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export type BreadcrumbItem = {
  label: string;
  to?: string;
};

type Props = {
  items: BreadcrumbItem[];
  className?: string;
};

export default function RouteBreadcrumbs({ items, className }: Props) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("mb-3 flex flex-wrap items-center gap-1 text-sm", className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
            )}
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(isLast ? "font-medium text-foreground" : "text-muted-foreground")}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
