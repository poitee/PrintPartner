import { type MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  spineFillIndex,
  spineFillStageCount,
  type WorkflowStage,
  type WorkflowStageId,
} from "../lib/workflowStages";

type Props = {
  stages: WorkflowStage[];
  activeId: WorkflowStageId | null;
  /** Compact row for mobile bottom bar. */
  variant?: "rail" | "mobile";
  collapsed?: boolean;
  onNavigate?: (to: string, e: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
};

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
        aria-label="Workflow stages"
      >
        {stages.map((stage) => {
          const active = stage.id === activeId;
          return (
            <NavLink
              key={stage.id}
              to={stage.to}
              onClick={(e) => onNavigate?.(stage.to, e)}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5 text-center transition-colors sm:px-1",
                active
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    active
                      ? "bg-primary"
                      : stage.warn
                        ? "bg-amber-500"
                        : stage.done
                          ? "bg-emerald-500"
                          : "bg-border",
                  )}
                />
                <span
                  className={cn(
                    "truncate text-[10px] font-medium sm:text-[11px]",
                    active && "font-semibold",
                    stage.dim && !active && "opacity-60",
                  )}
                >
                  {stage.label}
                </span>
              </span>
              {(stage.meta || stage.warn) && (
                <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
                  {stage.meta ? (
                    <span
                      className={cn(
                        stage.warn
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground",
                        active && !stage.warn && "text-primary",
                      )}
                    >
                      {stage.meta}
                    </span>
                  ) : null}
                  {stage.warn ? (
                    <span
                      className="inline-block h-1.5 w-1.5 rotate-45 bg-amber-600 dark:bg-amber-400"
                      aria-label="Warning"
                    />
                  ) : null}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>
    );
  }

  const fillCount = spineFillStageCount(stages);
  const fillIdx = spineFillIndex(stages, activeId);
  /** Approximate per-row height (py-2 + label) for the filled spine segment (Library→Progress). */
  const fillPx =
    fillCount <= 1
      ? 0
      : Math.round((fillIdx / (fillCount - 1)) * ((fillCount - 1) * 40));
  /** Leave Export outside the spine track. */
  const trackBottomPx = Math.max(0, (stages.length - fillCount) * 40 + 20);

  if (collapsed) {
    return (
      <nav className={cn("relative flex flex-col gap-1", className)} aria-label="Workflow stages">
        {stages.map((stage) => {
          const active = stage.id === activeId;
          return (
            <NavLink
              key={stage.id}
              to={stage.to}
              onClick={(e) => onNavigate?.(stage.to, e)}
              title={`${stage.label}${stage.meta ? ` · ${stage.meta}` : ""}${stage.warn ? " · warning" : ""}`}
              aria-label={`${stage.label}${stage.warn ? ", warning" : ""}`}
              className={cn(
                "relative flex items-center justify-center rounded-md p-2.5 transition-colors",
                active
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full ring-2 ring-card",
                  active
                    ? "bg-primary ring-primary/40"
                    : stage.warn
                      ? "bg-amber-500"
                      : stage.done
                        ? "bg-emerald-500"
                        : "bg-border",
                )}
              />
              {stage.warn ? (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rotate-45 bg-amber-600" />
              ) : null}
            </NavLink>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      className={cn("relative flex flex-col", className)}
      aria-label="Workflow stages"
    >
      <div
        className="pointer-events-none absolute left-[15px] top-4 w-0.5 bg-border"
        style={{ bottom: `${trackBottomPx}px` }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute left-[15px] top-4 w-0.5 bg-primary transition-[height] duration-300"
        style={{ height: `${fillPx}px` }}
        aria-hidden
      />
      {stages.map((stage) => {
        const active = stage.id === activeId;
        return (
          <NavLink
            key={stage.id}
            to={stage.to}
            onClick={(e) => onNavigate?.(stage.to, e)}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
              active
                ? "bg-primary/12"
                : "hover:bg-accent/70",
            )}
          >
            <span
              className={cn(
                "relative z-[1] h-2.5 w-2.5 shrink-0 rounded-full ring-[3px] ring-card",
                active
                  ? "bg-primary ring-primary/30"
                  : stage.warn
                    ? "bg-amber-500 ring-amber-500/30"
                    : stage.done
                      ? "bg-emerald-500"
                      : "bg-border",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 text-[13px]",
                active
                  ? "font-semibold text-primary"
                  : stage.dim
                    ? "font-medium text-muted-foreground/70"
                    : "font-medium text-foreground",
              )}
            >
              {stage.label}
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5">
              {stage.meta ? (
                <span
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    stage.warn
                      ? "text-amber-700 dark:text-amber-300"
                      : active
                        ? "text-primary"
                        : "text-muted-foreground",
                  )}
                >
                  {stage.meta}
                </span>
              ) : null}
              {stage.warn ? (
                <span
                  className="inline-block h-1.5 w-1.5 rotate-45 bg-amber-600 dark:bg-amber-400"
                  aria-label="Warning"
                />
              ) : null}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}
