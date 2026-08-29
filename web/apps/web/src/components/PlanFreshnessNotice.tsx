import type { PlanFreshness } from "@print-partner/contracts";
import { AlertTriangle, CircleHelp, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { planFreshnessMessages } from "../lib/planAcceptanceModel";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

type Action =
  | { kind: "rebuild"; onRebuild: () => void; busy?: boolean }
  | { kind: "review"; href: string };

type Props = {
  freshness: PlanFreshness;
  action: Action;
  className?: string;
};

export default function PlanFreshnessNotice({ freshness, action, className }: Props) {
  if (freshness.status === "current") return null;

  const messages = planFreshnessMessages(freshness);
  const Icon = freshness.status === "stale" ? AlertTriangle : CircleHelp;

  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm print:hidden",
        className,
      )}
      role="status"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {freshness.status === "stale"
            ? "Sources have changed since this Plan was accepted"
            : "Plan inputs are not tracked"}
        </p>
        {messages.map((message) => (
          <p key={message} className="text-muted-foreground">
            {message}
          </p>
        ))}
      </div>
      {action.kind === "rebuild" ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={action.busy}
          onClick={action.onRebuild}
        >
          <RefreshCw
            className={cn("mr-1.5 h-3.5 w-3.5", action.busy && "animate-spin")}
            aria-hidden
          />
          {action.busy ? "Updating…" : "Update Working Plan"}
        </Button>
      ) : (
        <Button type="button" size="sm" variant="secondary" asChild>
          <Link to={action.href}>Review Sources</Link>
        </Button>
      )}
    </div>
  );
}
