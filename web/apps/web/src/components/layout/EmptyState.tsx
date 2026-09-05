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
import { cn } from "@/lib/utils";

type Props = {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
  /** `sm` for inline panels; default is page-level empty state */
  size?: "default" | "sm";
};

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
            "desk-well mb-0 rounded-lg border-border bg-surface-sunken text-muted-foreground",
            compact ? "size-12 [&_svg]:size-5" : "size-14 [&_svg]:size-6",
          )}
        >
          <Icon />
        </EmptyMedia>
        <EmptyTitle
          className={cn(
            "font-serif tracking-tight",
            compact ? "text-sm" : "text-title",
          )}
        >
          {title}
        </EmptyTitle>
        {description ? (
          <EmptyDescription className="max-w-md">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? (
        <EmptyContent>
          <Button size={compact ? "sm" : "shop"} onClick={action.onClick}>
            {action.label}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
