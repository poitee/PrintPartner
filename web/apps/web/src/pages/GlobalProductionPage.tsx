import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Factory } from "lucide-react";
import type { UnattributedPrint } from "@print-partner/contracts";
import {
  fetchPrinterCheckoffLinks,
  fetchUnattributedPrints,
  type PrinterCheckoffLink,
} from "../api/endpoints/checkoff";
import UnattributedPrintCard from "../components/checkoff/UnattributedPrintCard";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import {
  globalProductionJobLabel,
  partitionGlobalProductionJobs,
  recentVerifiedJobs,
  toGlobalProductionJob,
  type GlobalProductionJob,
} from "../lib/globalProduction";
import { filterPlansList, planProgressLabel } from "../lib/plansList";
import { buildsRoute, productionRoute, progressRoute } from "../lib/routes";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";

const PrinterLiveStrip = lazy(() => import("../components/checkoff/PrinterLiveStrip"));

function JobList({
  title,
  jobs,
  nested = false,
}: {
  title: string;
  jobs: GlobalProductionJob[];
  nested?: boolean;
}) {
  if (jobs.length === 0) return null;
  return (
    <section className="space-y-2">
      {nested ? (
        <h3 className="text-sm font-medium">{title}</h3>
      ) : (
        <h2 className="text-sm font-medium">{title}</h2>
      )}
      <ul className="space-y-2" aria-label={title}>
        {jobs.map((job) => (
          <li key={job.id}>
            <Card className="shadow-none">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{job.planName}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {job.hostName} · {job.filename}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="rounded-md border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                    {globalProductionJobLabel(job.state)}
                  </span>
                  <Link
                    className="min-h-11 content-center underline-offset-2 hover:underline"
                    to={job.checkoffHref}
                    aria-label={`${globalProductionJobLabel(job.state)} for ${job.planName}`}
                  >
                    Checkoff
                  </Link>
                  <Link
                    className="min-h-11 content-center underline-offset-2 hover:underline"
                    to={job.productionHref}
                    aria-label={`Open ${job.planName} work packages in Production`}
                  >
                    Production
                  </Link>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function GlobalProductionPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { profiles, loading, error: profilesError, reloadProfiles } = useProfileSelection();
  const engineState = resolveEngineState({ health, loading: healthLoading, error: engineError });
  const profilesState = resolveResourceState({
    loading,
    error: profilesError,
    hasData: profiles.length > 0,
  });
  const profilesBackgroundError = getBackgroundError(profilesError, profiles.length > 0);
  const rows = useMemo(
    () => filterPlansList(profiles, "active", "", "recent"),
    [profiles],
  );
  const planNameById = useMemo(() => {
    const names = new Map<number, string>();
    for (const plan of profiles) names.set(plan.id, plan.name);
    return names;
  }, [profiles]);

  const [activeLinks, setActiveLinks] = useState<PrinterCheckoffLink[]>([]);
  const [verifiedLinks, setVerifiedLinks] = useState<PrinterCheckoffLink[]>([]);
  const [unattributed, setUnattributed] = useState<UnattributedPrint[]>([]);
  const [farmError, setFarmError] = useState<string | null>(null);
  const farmRequestId = useRef(0);

  const refreshFarm = useCallback(async () => {
    if (engineState !== "ready") {
      setActiveLinks([]);
      setVerifiedLinks([]);
      setUnattributed([]);
      setFarmError(null);
      return;
    }
    const requestId = ++farmRequestId.current;
    try {
      const [watching, awaiting, failed, verified, prints] = await Promise.all([
        fetchPrinterCheckoffLinks({ state: "watching" }),
        fetchPrinterCheckoffLinks({ state: "awaiting_verify" }),
        fetchPrinterCheckoffLinks({ state: "host_failed" }),
        fetchPrinterCheckoffLinks({ state: "verified" }),
        fetchUnattributedPrints(),
      ]);
      if (requestId !== farmRequestId.current) return;
      setActiveLinks([
        ...(watching.links ?? []),
        ...(awaiting.links ?? []),
        ...(failed.links ?? []),
      ]);
      setVerifiedLinks(verified.links ?? []);
      setUnattributed(prints);
      setFarmError(null);
    } catch (error) {
      if (requestId !== farmRequestId.current) return;
      setFarmError(error instanceof Error ? error.message : String(error));
    }
  }, [engineState]);

  useEffect(() => {
    void refreshFarm();
  }, [refreshFarm]);

  const jobs = useMemo(
    () =>
      activeLinks
        .map((link) => toGlobalProductionJob(link, planNameById))
        .filter((job): job is GlobalProductionJob => job != null),
    [activeLinks, planNameById],
  );
  const buckets = useMemo(() => partitionGlobalProductionJobs(jobs), [jobs]);
  const recent = useMemo(
    () => recentVerifiedJobs(verifiedLinks, planNameById),
    [verifiedLinks, planNameById],
  );

  return (
    <PageShell width="list" className="space-y-6">
      <PageHeader
        icon={Factory}
        accent
        eyebrow="Workshop"
        title="All Production"
        description="Work packages and farm status across all Builds. Queue dispatch and printer preparation stay in each Build's Production workspace."
      />

      {profilesBackgroundError && (
        <p className="text-sm text-destructive" role="alert">
          Could not refresh builds: {profilesBackgroundError}
        </p>
      )}
      {farmError && (
        <p className="text-sm text-destructive" role="alert">
          Could not refresh production: {farmError}
        </p>
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline. Start the print-partner engine to see production."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Suspense fallback={null}>
            <PrinterLiveStrip
              engineReady
              onCheckoffUpdate={() => void refreshFarm()}
              onUnattributedUpdate={() => void refreshFarm()}
            />
          </Suspense>

          {unattributed.length > 0 || buckets.awaiting.length > 0 || buckets.failed.length > 0 ? (
            <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-labelledby="production-attention-heading">
              <div>
                <h2 id="production-attention-heading" className="text-sm font-semibold">
                  Attention needed
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Match unknown printer files, verify finished parts, and resolve failed jobs.
                </p>
              </div>
              {unattributed.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Unmatched printer files</h3>
                  <div className="flex flex-col gap-2">
                    {unattributed.map((print) => (
                      <UnattributedPrintCard
                        key={print.id}
                        print={print}
                        profiles={profiles}
                        onClaimed={() => void refreshFarm()}
                        onDismissed={() => void refreshFarm()}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <JobList title="Parts to verify" jobs={buckets.awaiting} nested />
              <JobList title="Failed jobs" jobs={buckets.failed} nested />
            </section>
          ) : null}

          <JobList title="Printing now" jobs={buckets.watching} />

          {recent.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Recent work</h2>
              <ul className="space-y-2" aria-label="Recent work">
                {recent.map((job) => (
                  <li key={job.id}>
                    <Card className="shadow-none">
                      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{job.planName}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {job.filename}
                          </p>
                        </div>
                        <Link
                          className="text-xs underline-offset-2 hover:underline"
                          to={job.checkoffHref}
                          aria-label={`Checkoff for ${job.planName}`}
                        >
                          Checkoff
                        </Link>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {profilesState === "error" ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive" role="alert">
              Could not load builds: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profilesState === "loading" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading production…</p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active Builds.{" "}
          <Link className="underline-offset-2 hover:underline" to={buildsRoute()}>
            Go to Builds
          </Link>
        </p>
      ) : (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Remaining by Build</h2>
          <ul className="space-y-2" aria-label="Production by Build">
            {rows.map((plan) => (
              <li key={plan.id}>
                <Card className="shadow-none">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{plan.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {planProgressLabel(plan.accepted_progress)}
                        {plan.build_stale ? " · stale" : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs">
                      <Link
                        className="underline-offset-2 hover:underline"
                        to={progressRoute(plan.id)}
                        aria-label={`Checkoff for ${plan.name}`}
                      >
                        Checkoff
                      </Link>
                      <Link
                        className="underline-offset-2 hover:underline"
                        to={productionRoute(plan.id)}
                        aria-label={`Open ${plan.name} in Production`}
                      >
                        Production
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}
