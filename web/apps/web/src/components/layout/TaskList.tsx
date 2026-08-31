import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import {
  statusTone,
  workflowStatusPresentation,
  type WorkflowStatusKind,
} from "@/lib/statusTone";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

/**
 * Task states for a workspace task list.
 *
 * A subset of the workflow states: a task list never says "ready" or "needs
 * refresh". Tone, words, and icon shape all come from `lib/statusTone`, so a
 * task row and a Build stage badge read the same.
 */
export type WorkflowTaskState = Extract<
  WorkflowStatusKind,
  "not_started" | "in_progress" | "needs_attention" | "blocked" | "complete" | "error"
>;

export type WorkflowTask = Readonly<{
  id: string;
  /** Short task name. Keep it a verb phrase. */
  label: string;
  /** One line of context under the label. */
  hint?: ReactNode;
  state: WorkflowTaskState;
  /** Names the state and its owner, e.g. "Needs your decision". */
  statusLabel: string;
  /** Route for the task. The whole row links when this is set. */
  to?: string;
  /** Used when the task has no route of its own. */
  onAction?: () => void;
  actionLabel?: string;
  /** Required when state is "blocked". Explains what must happen first. */
  disabledReason?: string;
  /** Persistent inline failure. Retry reruns the failed operation. */
  error?: { message: string; onRetry?: () => void; retryLabel?: string };
}>;

type Props = {
  /** Optional heading above the list. */
  title?: string;
  /** Optional line under the heading. */
  description?: ReactNode;
  tasks: readonly WorkflowTask[];
  className?: string;
};

/**
 * Status colour is always paired with the visible `statusLabel` and with the
 * state's own icon shape, so colour never carries meaning on its own (WCAG G14).
 */
function stateClasses(state: WorkflowTaskState): string {
  return statusTone({ tone: workflowStatusPresentation(state).tone, emphasis: "soft" });
}

function TaskIcon({ state }: { state: WorkflowTaskState }) {
  const Icon = workflowStatusPresentation(state).icon;
  return (
    <span
      className={cn(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        stateClasses(state),
      )}
      aria-hidden
    >
      <Icon className={cn("h-3.5 w-3.5", state === "in_progress" && "animate-spin")} />
    </span>
  );
}

function TaskBody({ task }: { task: WorkflowTask }) {
  return (
    <>
      <TaskIcon state={task.state} />
      {/* On a phone the label owns the full row width and the status and action
          drop to a second line. Squeezing all three onto one line shrinks the
          label to a narrow column that wraps after every word. */}
      <span className="min-w-0 flex-1 basis-[calc(100%-2.25rem)] sm:basis-auto">
        <span className="block text-sm font-medium text-foreground">{task.label}</span>
        {task.hint ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{task.hint}</span>
        ) : null}
        {task.state === "blocked" && task.disabledReason ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            {task.disabledReason}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * A GOV.UK style task list: related tasks that a user may complete in the order
 * that suits them. Each row names the task, states its status in text, and
 * either links to the task or offers its action. The status is inside the same
 * link text, so assistive technology reads the task and its status together.
 *
 * Use this in workspaces where order is flexible (Sources, Production). Do not
 * use it as a step indicator, and do not nest one task list inside another.
 */
export default function TaskList({ title, description, tasks, className }: Props) {
  if (tasks.length === 0) return null;

  return (
    <section
      className={cn("rounded-lg border border-border bg-card", className)}
      aria-label={title ?? "Tasks"}
    >
      {title ? (
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}

      <ul className="divide-y divide-border">
        {tasks.map((task) => {
          const status = (
            <span
              className={cn(
                "shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium",
                stateClasses(task.state),
              )}
            >
              {task.statusLabel}
            </span>
          );

          return (
            <li key={task.id}>
              {task.to && task.state !== "blocked" ? (
                <Link
                  to={task.to}
                  className="flex min-h-11 w-full flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 sm:flex-nowrap"
                >
                  <TaskBody task={task} />
                  <span className="flex w-full items-center gap-2 pl-9 sm:w-auto sm:pl-0">
                    {status}
                    <ChevronRight
                      className="ml-auto h-4 w-4 shrink-0 text-muted-foreground sm:ml-0 sm:mt-0.5"
                      aria-hidden
                    />
                  </span>
                </Link>
              ) : (
                <div className="flex min-h-11 w-full flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap">
                  <TaskBody task={task} />
                  <span className="flex w-full items-center gap-2 pl-9 sm:w-auto sm:pl-0">
                    {status}
                    {task.onAction && task.state !== "blocked" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="ml-auto min-h-9 shrink-0 sm:ml-0"
                        onClick={task.onAction}
                      >
                        {task.actionLabel ?? task.label}
                      </Button>
                    ) : null}
                  </span>
                </div>
              )}

              {task.error ? (
                <div
                  className={cn(
                    "mx-4 mb-3 flex flex-wrap items-center gap-3 rounded-md px-3 py-2",
                    statusTone({ tone: "error", emphasis: "surface" }),
                  )}
                  role="alert"
                >
                  <p className="min-w-0 flex-1 text-xs text-destructive">
                    {task.error.message}
                  </p>
                  {task.error.onRetry ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="min-h-9 shrink-0"
                      onClick={task.error.onRetry}
                    >
                      {task.error.retryLabel ?? "Retry"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
