import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { cn } from "../../lib/utils";

type Props = {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
  /** `sm` for inline panels; default is page-level empty state */
  size?: "default" | "sm";
};

/** Page empty — thin wrapper over shadcn Empty (GRE-226). */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = "default",
}: Props) {
  const compact = size === "sm";
  return (
    <Empty
      className={cn(
        compact ? "gap-4 px-4 py-8 md:p-8" : undefined,
        className,
      )}
    >
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className={cn(
            "rounded-full border border-accent-brand/15 bg-accent-brand/10 text-accent-brand",
            compact ? "size-12 [&_svg]:size-5" : "size-14 [&_svg]:size-6",
          )}
        >
          <Icon />
        </EmptyMedia>
        <EmptyTitle className={cn(compact ? "text-sm" : "text-base")}>
          {title}
        </EmptyTitle>
        {description ? (
          <EmptyDescription className="max-w-md">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? (
        <EmptyContent>
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
