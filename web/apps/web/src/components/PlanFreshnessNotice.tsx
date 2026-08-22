import type { PlanFreshness, PlanStaleReason, PlanUntrackedReason } from "@print-partner/contracts";
import { AlertTriangle, CircleHelp, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

type Action =
  | { kind: "rebuild"; onRebuild: () => void; busy?: boolean }
  | { kind: "review"; href: string };

type Props = {
  freshness: PlanFreshness;
  action: Action;
  className?: string;
};

function staleReasonText(reason: PlanStaleReason): string {
  switch (reason.kind) {
    case "source_revision_changed":
      return `${reason.source_name} has a newer synced revision.`;
    case "source_revision_unavailable":
      return `${reason.source_name}'s accepted revision is no longer available.`;
    case "naming_rules_changed":
      return `${reason.source_name}'s part naming rules changed.`;
    case "plan_inputs_invalid":
      return "The Plan has duplicate or missing Source assignments.";
    case "plan_configuration_changed":
      return "The Plan's source selection or file rules changed.";
  }
}

function untrackedReasonText(reason: PlanUntrackedReason): string {
  switch (reason.kind) {
    case "no_accepted_inputs":
      return "This Plan has not recorded the source revisions used to build its parts yet.";
    case "source_revision_untracked":
      return `${reason.source_name} does not have a tracked source revision.`;
  }
}

export default function PlanFreshnessNotice({ freshness, action, className }: Props) {
  if (freshness.status === "current") return null;

  const messages =
    freshness.status === "stale"
      ? [
          ...freshness.reasons.map(staleReasonText),
          ...freshness.untracked_sources.map(untrackedReasonText),
        ]
      : freshness.reasons.map(untrackedReasonText);
  const Icon = freshness.status === "stale" ? AlertTriangle : CircleHelp;

  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm print:hidden",
        className,
      )}
      role="status"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {freshness.status === "stale" ? "Plan rebuild needed" : "Plan inputs are not tracked"}
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
          {action.busy ? "Rebuilding…" : "Rebuild plan"}
        </Button>
      ) : (
        <Button type="button" size="sm" variant="secondary" asChild>
          <Link to={action.href}>Review in Plan</Link>
        </Button>
      )}
    </div>
  );
}
