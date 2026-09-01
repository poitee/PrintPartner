import { AlertTriangle, CircleHelp, PackageCheck } from "lucide-react";
import type {
  CheckoffAttentionItem,
  CheckoffAttentionKind,
} from "../../lib/checkoffConsoleModel";
import { statusTone, type StatusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";

type Props = {
  items: CheckoffAttentionItem[];
  className?: string;
};

const TONE_BY_KIND: Record<CheckoffAttentionKind, StatusTone> = {
  awaiting_verification: "warning",
  failed_print: "error",
  unmatched_activity: "info",
};

const ICON_BY_KIND: Record<CheckoffAttentionKind, typeof AlertTriangle> = {
  awaiting_verification: PackageCheck,
  failed_print: AlertTriangle,
  unmatched_activity: CircleHelp,
};

/**
 * What is waiting, in priority order, before the controls that resolve it.
 *
 * Each row states the physical result, the printer that produced it, and who
 * has to act. Status is text; the tone only repeats what the words say.
 */
export default function CheckoffAttentionSummary({ items, className }: Props) {
  if (items.length === 0) return null;

  return (
    <ol className={cn("flex flex-col gap-2", className)} aria-label="Results needing attention">
      {items.map((item) => {
        const Icon = ICON_BY_KIND[item.kind];
        return (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
          >
            <span
              className={cn(
                "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full",
                statusTone({ tone: TONE_BY_KIND[item.kind], emphasis: "soft" }),
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate font-mono text-sm text-foreground">{item.title}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-micro font-semibold",
                    statusTone({ tone: TONE_BY_KIND[item.kind], emphasis: "soft" }),
                  )}
                >
                  {item.statusLabel}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{item.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
