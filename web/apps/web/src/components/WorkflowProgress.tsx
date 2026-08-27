import { Fragment, type MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { ClipboardList, Import, ListChecks, PackageCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  workflowStatusLabel,
  type WorkflowStage,
  type WorkflowStageId,
} from "../lib/workflowStages";

const STAGE_ICONS: Record<WorkflowStageId, typeof Import> = {
  sources: Import,
  plan: ClipboardList,
  production: PackageCheck,
  checkoff: ListChecks,
};

type Props = {
  stages: WorkflowStage[];
  activeId: WorkflowStageId | null;
  variant?: "rail" | "mobile";
  collapsed?: boolean;
  onNavigate?: (to: string, event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
};

function isAttention(stage: WorkflowStage): boolean {
  return stage.status.kind === "needs_attention"
    || stage.status.kind === "stale"
    || stage.status.kind === "error";
}

function statusDotClass(stage: WorkflowStage, active: boolean): string {
  if (active) return "bg-primary ring-primary/30";
  switch (stage.status.kind) {
    case "complete":
      return "bg-success";
    case "needs_attention":
    case "stale":
      return "bg-warning ring-warning/30";
    case "error":
      return "bg-destructive ring-destructive/30";
    case "in_progress":
    case "ready":
      return "bg-primary/70 ring-primary/20";
    case "not_started":
      return "bg-border";
  }
}

function statusTextClass(stage: WorkflowStage, active: boolean): string {
  if (active) return "text-primary";
  switch (stage.status.kind) {
    case "complete":
      return "text-success";
    case "needs_attention":
    case "stale":
      return "text-warning";
    case "error":
      return "text-destructive";
    case "in_progress":
    case "ready":
      return "text-foreground";
    case "not_started":
      return "text-muted-foreground";
  }
}

function stageAriaLabel(stage: WorkflowStage): string {
  return `${stage.label}, ${workflowStatusLabel(stage.status.kind)}. ${stage.status.summary}`;
}

export default function WorkflowProgress({
  stages,
  activeId,
  variant = "rail",
  collapsed = false,
  onNavigate,
  className,
}: Props) {
  if (variant === "mobile") {
    return (
      <nav
        className={cn(
          "flex shrink-0 gap-0.5 border-t border-border bg-card/95 px-1.5 py-1.5 backdrop-blur-sm print:hidden sm:gap-1 sm:px-2",
          className,
        )}
        aria-label="Build Workflow"
      >
        {stages.map((stage, index) => {
          const active = stage.id === activeId;
          const startsMake = index > 0 && stages[index - 1]?.group !== stage.group;
          return (
            <NavLink
              key={stage.id}
              to={stage.to}
              onClick={(event) => onNavigate?.(stage.to, event)}
              title={stage.status.summary}
              aria-label={stageAriaLabel(stage)}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5 text-center transition-colors sm:px-1",
                startsMake && "border-l border-border",
                active
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    statusDotClass(stage, active),
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    "truncate text-3xs font-medium sm:text-2xs",
                    active && "font-semibold",
                    stage.status.kind === "not_started" && !active && "opacity-60",
                  )}
                >
                  {stage.label}
                </span>
              </span>
              <span
                className={cn(
                  "truncate text-3xs",
                  statusTextClass(stage, active),
                )}
              >
                {workflowStatusLabel(stage.status.kind)}
              </span>
            </NavLink>
          );
        })}
      </nav>
    );
  }

  if (collapsed) {
    return (
      <nav
        className={cn("relative flex flex-col gap-1", className)}
        aria-label="Build Workflow"
      >
        {stages.map((stage, index) => {
          const active = stage.id === activeId;
          const Icon = STAGE_ICONS[stage.id];
          const startsMake = index > 0 && stages[index - 1]?.group !== stage.group;
          return (
            <Fragment key={stage.id}>
              {startsMake ? <div className="mx-1 my-1 border-t border-border" aria-hidden /> : null}
              <NavLink
                to={stage.to}
                onClick={(event) => onNavigate?.(stage.to, event)}
                title={stageAriaLabel(stage)}
                aria-label={stageAriaLabel(stage)}
                className={cn(
                  "relative flex items-center justify-center rounded-md p-2.5 transition-colors",
                  active
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                  stage.status.kind === "not_started" && !active && "opacity-60",
                )}
              >
                <Icon className="h-4 w-4" />
                {isAttention(stage) ? (
                  <span
                    className={cn(
                      "absolute right-1 top-1 h-1.5 w-1.5 rotate-45",
                      stage.status.kind === "error" ? "bg-destructive" : "bg-warning",
                    )}
                    aria-hidden
                  />
                ) : stage.status.kind === "complete" ? (
                  <span
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-success ring-2 ring-card"
                    aria-hidden
                  />
                ) : stage.status.kind === "ready" || stage.status.kind === "in_progress" ? (
                  <span
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-card"
                    aria-hidden
                  />
                ) : null}
              </NavLink>
            </Fragment>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      className={cn("relative flex flex-col gap-1", className)}
      aria-label="Build Workflow"
    >
      {stages.map((stage, index) => {
        const active = stage.id === activeId;
        const startsGroup = index === 0 || stages[index - 1]?.group !== stage.group;
        return (
          <Fragment key={stage.id}>
            {startsGroup ? (
              <p
                className={cn(
                  "px-2 pt-1 font-mono text-3xs font-semibold uppercase tracking-[0.14em] text-muted-foreground",
                  index > 0 && "mt-2 border-t border-border pt-3",
                )}
              >
                {stage.group === "prepare" ? "Prepare" : "Make"}
              </p>
            ) : null}
            <NavLink
              to={stage.to}
              onClick={(event) => onNavigate?.(stage.to, event)}
              title={stage.status.summary}
              aria-label={stageAriaLabel(stage)}
              className={cn(
                "relative flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                active ? "bg-primary/12" : "hover:bg-accent/70",
              )}
            >
              <span
                className={cn(
                  "relative z-[1] mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-[3px] ring-card",
                  statusDotClass(stage, active),
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm font-medium",
                    active
                      ? "font-semibold text-primary"
                      : stage.status.kind === "not_started"
                        ? "text-muted-foreground/70"
                        : "text-foreground",
                  )}
                >
                  {stage.label}
                </span>
                <span className="block truncate text-3xs text-muted-foreground">
                  {stage.status.summary}
                </span>
              </span>
              <span
                className={cn(
                  "mt-0.5 shrink-0 text-3xs font-medium",
                  statusTextClass(stage, active),
                )}
              >
                {workflowStatusLabel(stage.status.kind)}
              </span>
            </NavLink>
          </Fragment>
        );
      })}
    </nav>
  );
}
