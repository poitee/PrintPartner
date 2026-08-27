import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchBuildPlanningState,
  type BuildPlanningState,
} from "../../api/endpoints/planManifests";
import { Badge } from "../ui/badge";
import { planRoute } from "../../lib/routes";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

function planningPhaseDescription(phase: BuildPlanningState["planning_phase"]): string {
  switch (phase.kind) {
    case "preparing":
      return "Working Plan not built yet";
    case "draft":
      return `Working Plan ${phase.draft_id}`;
    case "applied":
      return phase.revision_id == null
        ? `Working Plan ${phase.draft_id} accepted`
        : `Accepted as Plan revision ${phase.revision_id}`;
    case "abandoned":
      return `Working Plan ${phase.draft_id} abandoned`;
    case "missing_draft":
      return `Working Plan ${phase.draft_id} is unavailable`;
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
  const [state, setState] = useState<BuildPlanningState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState(null);
    setError(null);
    if (planId == null)
      return () => {
        active = false;
      };
    void fetchBuildPlanningState(planId)
      .then((planning) => {
        if (active) setState(planning);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [planId]);

  if (planId == null || (!state && !error)) return null;
  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Could not load Build planning: {error}
      </p>
    );
  }
  if (!state) return null;

  const { brief, planning_phase: planningPhase, readiness } = state;
  const phaseBadge: {
    label: string;
    variant: "success" | "warning" | "error";
  } = planningPhase.kind === "applied"
    ? { label: "Accepted", variant: "success" }
    : planningPhase.kind === "abandoned"
      ? { label: "Working Plan abandoned", variant: "warning" }
      : planningPhase.kind === "missing_draft"
        ? { label: "Working Plan unavailable", variant: "error" }
        : {
            label: readiness.ready
              ? "Ready for Plan review"
              : `${readiness.blockers.length} blockers`,
            variant: readiness.ready ? "success" : "warning",
          };
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>AI Build planning</CardTitle>
          <Badge variant={phaseBadge.variant}>{phaseBadge.label}</Badge>
        </div>
        <CardDescription>
          {planningPhaseDescription(planningPhase)}{" "}
          · {state.difference_count} source differences in{" "}
          {state.grouped_difference_count} groups
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="whitespace-pre-wrap text-muted-foreground">
          {brief.special_request}
        </p>

        {readiness.ready && planningPhase.kind === "draft" ? (
          <Link
            to={planRoute(planId)}
            className="inline-flex font-medium text-primary underline-offset-2 hover:underline"
          >
            Open Plan to review and accept the Working Plan
          </Link>
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
              Blocking decisions
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
