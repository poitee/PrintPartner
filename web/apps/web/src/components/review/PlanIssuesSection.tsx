import { Link } from "react-router-dom";
import { AlertTriangle, CircleAlert } from "lucide-react";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { planDraftRevisionPartLabels } from "../../lib/planDraftUi";
import { statusTone } from "../../lib/statusTone";
import type { PlanIssue } from "../../lib/planAcceptanceModel";
import { Button } from "../ui/button";
import { usePlanAcceptance } from "./PlanAcceptanceContext";
import { cn } from "@/lib/utils";

/**
 * Step 3 of the Plan checkpoint: every open question in one place.
 *
 * "Must resolve" holds the items that stop acceptance. "Review recommended"
 * holds items that acceptance allows but Production or the shop floor will
 * feel. The summary at the top links to each one, following the GOV.UK error
 * summary pattern, and every item carries its state as text.
 */
export default function PlanIssuesSection() {
  const {
    model,
    busy,
    syncBusy,
    decisionChoices,
    decisionsComplete,
    chooseDecision,
    saveDecisions,
    refreshWorkingPlan,
    accept,
    syncSources,
  } = usePlanAcceptance();
  const { draftWorkspace } = usePlanWorkspace();

  const conflicts =
    draftWorkspace?.reconciliation.kind === "unresolved"
      ? draftWorkspace.reconciliation.conflicts
      : [];
  const acceptedPartLabels = draftWorkspace
    ? planDraftRevisionPartLabels(draftWorkspace)
    : new Map<number, string>();
  if (model.issues.length === 0) return null;

  const renderAction = (issue: PlanIssue) => {
    const action = issue.action;
    if (!action) return null;
    switch (action.kind) {
      case "route":
        return (
          <Button variant="secondary" size="sm" className="min-h-11" asChild>
            <Link to={action.to}>{action.label}</Link>
          </Button>
        );
      case "sync_sources":
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-11"
            disabled={syncBusy}
            onClick={syncSources}
          >
            {syncBusy ? "Syncing sources…" : action.label}
          </Button>
        );
      case "refresh_working_plan":
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={refreshWorkingPlan}
          >
            {action.label}
          </Button>
        );
      case "move_records":
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-11"
            disabled={busy}
            loading={busy}
            onClick={() => accept({ moveLinkedRecords: true })}
          >
            {action.label}
          </Button>
        );
      case "required_unit_decision": {
        const conflict = conflicts.find(
          (item) => item.target_draft_part_id === action.draftPartId,
        );
        if (!conflict) return null;
        return (
          <select
            id={`${issue.id}-choice`}
            aria-labelledby={`${issue.id}-title`}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
            value={decisionChoices[action.draftPartId] ?? ""}
            disabled={busy}
            onChange={(event) => chooseDecision(action.draftPartId, event.target.value)}
          >
            <option value="">Choose what happens</option>
            {conflict.kind === "ambiguous_exact_match"
              ? conflict.candidate_revision_part_ids.map((candidateId) => (
                  <option key={candidateId} value={String(candidateId)}>
                    Keep printed units from {acceptedPartLabels.get(candidateId) ?? `part ${candidateId}`}
                  </option>
                ))
              : (
                  <option value={String(conflict.predecessor_revision_part_id)}>
                    Keep the units already printed
                  </option>
                )}
            <option value="replace">Print these units again</option>
          </select>
        );
      }
    }
  };

  const renderGroup = (
    id: string,
    title: string,
    hint: string,
    groupIssues: readonly PlanIssue[],
    withDecisionSave: boolean,
  ) => {
    if (groupIssues.length === 0) return null;
    return (
      <div className="mt-4">
        <h3 id={id} className="text-sm font-semibold">
          {title} ({groupIssues.length})
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        <ul className="mt-2 space-y-2">
          {groupIssues.map((issue) => (
            <li
              key={issue.id}
              id={issue.id}
              tabIndex={-1}
              className={cn(
                "rounded-md p-3 text-sm",
                statusTone({
                  tone: issue.tone === "error" ? "error" : "warning",
                  emphasis: "soft",
                }),
              )}
            >
              <div className="flex gap-2">
                {issue.tone === "error" ? (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide">
                    {issue.statusLabel}
                  </p>
                  <p id={`${issue.id}-title`} className="mt-0.5 font-medium text-foreground">
                    {issue.title}
                  </p>
                  {issue.detail && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{issue.detail}</p>
                  )}
                  <div className="mt-2">{renderAction(issue)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {withDecisionSave && conflicts.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            className="mt-2 min-h-11"
            disabled={busy || !decisionsComplete}
            loading={busy}
            onClick={saveDecisions}
          >
            Save Required-unit decisions
          </Button>
        )}
      </div>
    );
  };

  return (
    <section
      id="plan-issues"
      aria-labelledby="plan-issues-heading"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <h2 id="plan-issues-heading" className="text-sm font-semibold">
        Issues
      </h2>

      <nav
        aria-labelledby="plan-issue-summary-heading"
        className={cn(
          "mt-2 rounded-md p-3",
          statusTone({
            tone: model.mustResolve.length > 0 ? "error" : "warning",
            emphasis: "soft",
          }),
        )}
      >
        <h3 id="plan-issue-summary-heading" className="text-sm font-semibold">
          {model.mustResolve.length > 0
            ? `${model.mustResolve.length} of ${model.issues.length} issues block acceptance`
            : model.working
              ? `${model.issues.length} issues to check before you accept`
              : `${model.issues.length} issues to review`}
        </h3>
        <ul className="mt-1.5 space-y-1 text-sm">
          {model.issues.map((issue) => (
            <li key={`link-${issue.id}`}>
              <a className="underline underline-offset-2" href={`#${issue.id}`}>
                {issue.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {renderGroup(
        "plan-issues-must-resolve",
        "Must resolve",
        "Acceptance stays blocked until these are done.",
        model.mustResolve,
        true,
      )}
      {renderGroup(
        "plan-issues-review-recommended",
        "Review recommended",
        "These do not block acceptance. They change what Production and Checkoff can do.",
        model.reviewRecommended,
        false,
      )}
    </section>
  );
}
