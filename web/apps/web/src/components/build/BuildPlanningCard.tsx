import { Link } from "react-router-dom";
import type { BuildPlanningState } from "../../api/endpoints/planManifests";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { planRoute } from "../../lib/routes";
import { assistantChangeSummary } from "../../lib/sourcesSetupTasks";
import { useBuildPlanningQuery } from "./useBuildPlanningQuery";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

/**
 * Two checkpoints share the word "draft" in the code and must not share it in
 * the interface: what the assistant proposed, and the Working Plan that Plan
 * accepts. This card only ever says "assistant changes" or "Working Plan".
 */
function workingPlanState(phase: BuildPlanningState["planning_phase"]): string {
  switch (phase.kind) {
    case "preparing":
      return "The Working Plan is not built yet.";
    case "draft":
      return "The changes are in the Working Plan, waiting for Plan review.";
    case "applied":
      return phase.revision_id == null
        ? "The Working Plan was accepted."
        : `Accepted as Plan revision ${phase.revision_id}.`;
    case "abandoned":
      return "The Working Plan was dropped before it was accepted.";
    case "missing_draft":
      return "The Working Plan the assistant wrote is no longer available.";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export default function BuildPlanningCard({
  planId,
}: {
  planId: number | null;
}) {
  const planningQuery = useBuildPlanningQuery(planId);
  const state = planningQuery.data ?? null;
  const error = planningQuery.error;

  if (planId == null) return null;
  if (error) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/35 bg-destructive-soft px-3 py-2"
        role="alert"
      >
        <p className="min-w-0 flex-1 text-sm text-destructive">
          Could not load assistant changes:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="min-h-9"
          onClick={() => void planningQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!state) return null;

  const { brief, planning_phase: planningPhase, readiness } = state;
  const summary = assistantChangeSummary(state);
  const phaseBadge: {
    label: string;
    variant: "success" | "warning" | "error";
  } = planningPhase.kind === "applied"
    ? { label: "Applied", variant: "success" }
    : planningPhase.kind === "abandoned"
      ? { label: "Not finished", variant: "warning" }
      : planningPhase.kind === "missing_draft"
        ? { label: "Working Plan unavailable", variant: "error" }
        : {
            label: readiness.ready
              ? "Ready for Plan review"
              : `${readiness.blockers.length} ${readiness.blockers.length === 1 ? "decision" : "decisions"} needed`,
            variant: readiness.ready ? "success" : "warning",
          };
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Assistant changes</CardTitle>
          <Badge variant={phaseBadge.variant}>{phaseBadge.label}</Badge>
        </div>
        <CardDescription>
          {summary ? `${summary}. ` : ""}
          {workingPlanState(planningPhase)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {brief.special_request ? (
          <p className="whitespace-pre-wrap text-muted-foreground">
            {brief.special_request}
          </p>
        ) : null}

        {planningPhase.kind === "draft" || planningPhase.kind === "applied" ? (
          <Button variant="secondary" size="sm" className="min-h-9" asChild>
            <Link to={planRoute(planId)}>Open Plan to review the Working Plan</Link>
          </Button>
        ) : null}

        <section aria-labelledby="planning-requirements-heading">
          <h3 id="planning-requirements-heading" className="mb-2 font-medium">
            Requirements
          </h3>
          <ul className="space-y-1">
            {brief.requirements.map((requirement) => (
              <li
                key={`${requirement.key}:${requirement.value}`}
                className="flex flex-wrap items-center gap-2"
              >
                <Badge variant="outline">
                  {requirement.status.replaceAll("_", " ")}
                </Badge>
                <span>
                  {requirement.key.replaceAll("_", " ")}: {requirement.value}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {brief.compatibility_findings?.length ? (
          <section aria-labelledby="planning-compatibility-heading">
            <h3 id="planning-compatibility-heading" className="mb-2 font-medium">
              Compatibility
            </h3>
            <ul className="space-y-1">
              {brief.compatibility_findings.map((finding) => (
                <li key={finding.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{finding.status.replaceAll("_", " ")}</Badge>
                  <span>{finding.subject}: {finding.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="planning-evidence-heading">
          <h3 id="planning-evidence-heading" className="mb-2 font-medium">
            Sources and uploads
          </h3>
          <ul className="space-y-2">
            {brief.evidence.map((evidence) => (
              <li key={evidence.id} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {evidence.kind.replaceAll("_", " ")}
                  </Badge>
                  {evidence.source_role ? (
                    <span>{evidence.source_role.replaceAll("_", " ")}</span>
                  ) : null}
                  {evidence.sync_status ? (
                    <span>{evidence.sync_status}</span>
                  ) : null}
                </div>
                {evidence.normalized_url.startsWith("http") ? (
                  <a
                    className="mt-1 block break-all text-primary underline"
                    href={evidence.normalized_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {evidence.normalized_url}
                  </a>
                ) : (
                  <p className="mt-1 break-all">{evidence.normalized_url}</p>
                )}
                {evidence.artifacts?.length ? (
                  <p className="mt-1 text-muted-foreground">
                    {evidence.artifacts.length} uploaded artifacts:{" "}
                    {evidence.artifacts
                      .map((artifact) => artifact.path)
                      .join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {readiness.blockers.length > 0 ? (
          <section aria-labelledby="planning-blockers-heading">
            <h3 id="planning-blockers-heading" className="mb-2 font-medium">
              Decisions the assistant needs
            </h3>
            <ul className="list-disc space-y-1 pl-5">
              {readiness.blockers.map((blocker, index) => (
                <li key={`${blocker.code}:${blocker.detail}:${index}`}>
                  {blocker.detail}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
