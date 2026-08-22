import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  Box,
  Layers,
  Package,
  Printer,
  RefreshCw,
  XCircle,
} from "lucide-react";
import PlanFreshnessNotice from "../components/PlanFreshnessNotice";
import StlSyncBanner from "../components/StlSyncBanner";
import DeskNextStep from "../components/layout/DeskNextStep";
import EmptyState from "../components/layout/EmptyState";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import RouteBreadcrumbs from "../components/layout/RouteBreadcrumbs";
import ReviewPartsSheet, {
  type ReviewPartsSheetHandle,
} from "../components/review/ReviewPartsSheet";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { fetchStlNaming, startSync } from "../api/engine";
import type { StlNamingFolderRule } from "../api/engine";
import {
  buildSourcesRoute,
  exportRoute,
  libraryRoute,
  progressRoute,
} from "../lib/routes";
import {
  PARTS_CONFLICT_CTA,
  PARTS_CONFLICT_HINT,
} from "../lib/mergeConflictCopy";
import { countMissingStls, countNonMissingPartWarnings } from "../lib/partWarnings";
import { partsSummaryLine } from "../lib/partsGroups";
import { deskNextStepLine } from "../lib/deskNextStep";
import { flattenReviewParts } from "../lib/reviewParts";
import { groupMergeConflictsByFilename } from "../lib/mergeConflictGroups";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useStlAutoSync } from "../context/StlAutoSyncContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useJobRunner } from "../hooks/useJobRunner";
import { resolveEngineState } from "../lib/workflowState";

function hintRoute(hint: string | null | undefined, profileId: number | null) {
  if (hint === "sources") return libraryRoute();
  if (hint === "build" && profileId != null) return buildSourcesRoute(profileId);
  return null;
}

/**
 * Parts stage — validate quantities, group by filament role, surface warnings.
 * Heavy export actions live on `/export`; Progress owns checkoff.
 */
export default function PartsPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { selectedProfileId, profiles } = useProfileSelection();
  const {
    review,
    loading,
    error: workspaceError,
    refresh,
  } = usePlanWorkspace();
  const { banner: stlBanner, runSync: runStlSync, busy: stlSyncBusy } =
    useStlAutoSync();
  const syncJob = useJobRunner("sync");
  const sheetRef = useRef<ReviewPartsSheetHandle>(null);
  const [folderRules, setFolderRules] = useState<StlNamingFolderRule[]>([]);
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  useEffect(() => {
    void fetchStlNaming().then((profile) => {
      setFolderRules(
        (profile.folder_rules ?? []).filter((r) => r.functional_class != null),
      );
    }).catch(() => {/* silently ignore – filter just won't work */});
  }, []);
  const syncUnsyncedLayers = () => {
    const unsynced = review?.layers.filter((l) => !l.synced && l.project_id != null) ?? [];
    const ids = [...new Set(unsynced.map((l) => l.project_id!).filter(Boolean))];
    if (ids.length === 0) return;
    void syncJob.runJob(
      () => startSync(ids),
      (snap) => {
        if (snap.status === "error") {
          toast.error(snap.message || "Sync failed");
          return;
        }
        if (selectedProfileId != null) void refresh();
      },
    );
  };

  const loadError = workspaceError;
  const planName =
    profiles.find((p) => p.id === selectedProfileId)?.name ??
    review?.plan_name ??
    "Plan";

  const blockers = useMemo(
    () =>
      review?.issues.filter(
        (i) => i.severity === "blocker" && i.code !== "missing_stl",
      ) ?? [],
    [review],
  );
  const warnings = useMemo(
    () => review?.issues.filter((i) => i.severity === "warning") ?? [],
    [review],
  );
  const mergeConflicts = useMemo(
    () => review?.issues.filter((i) => i.code === "merge_conflict") ?? [],
    [review],
  );
  const mergeConflictGroups = useMemo(
    () => groupMergeConflictsByFilename(mergeConflicts),
    [mergeConflicts],
  );

  const hasIncludedParts = useMemo(() => {
    if (!review) return false;
    return flattenReviewParts(review.part_groups).some((p) => p.included);
  }, [review]);

  const summaryLine = useMemo(() => {
    if (!review) return null;
    const parts = flattenReviewParts(review.part_groups);
    const warnCount = countNonMissingPartWarnings(
      parts.filter((p) => p.included),
      review,
    );
    return partsSummaryLine(parts, review.totals.by_role, warnCount);
  }, [review]);

  const missingStlCount = useMemo(() => {
    if (!review) return 0;
    return countMissingStls(flattenReviewParts(review.part_groups));
  }, [review]);

  const partsNextStep = deskNextStepLine("parts", {
    partCount: hasIncludedParts ? 1 : 0,
    mergeConflictCount: mergeConflicts.length,
    missingStlCount,
  });

  const onPrint = useCallback(() => {
    void sheetRef.current?.print();
  }, []);

  return (
    <div className="space-y-4">
      <RouteBreadcrumbs
        items={[
          { label: "Sources", to: buildSourcesRoute(selectedProfileId) },
          { label: "Plan" },
        ]}
      />
      <PageHeader
        icon={Package}
        accent
        title="Plan"
        description={
          summaryLine ??
          "Validate parts, edit quantities, and export when ready."
        }
        actions={
          <PageHeaderActions>
            <Button
              variant="ghost"
              className="min-h-10 w-full sm:w-auto"
              onClick={onPrint}
              disabled={selectedProfileId == null || !hasIncludedParts}
            >
              <Printer className="mr-1 h-4 w-4" />
              Print
            </Button>
            <Button
              variant="secondary"
              className="min-h-10 w-full sm:w-auto"
              asChild
            >
              <Link to={progressRoute(selectedProfileId)}>Checkoff</Link>
            </Button>
            <Button className="min-h-10 w-full sm:w-auto" asChild>
              <Link to={exportRoute(selectedProfileId)}>Production</Link>
            </Button>
          </PageHeaderActions>
        }
      />

      <DeskNextStep>{partsNextStep}</DeskNextStep>

      {selectedProfile && (
        <PlanFreshnessNotice
          freshness={selectedProfile.freshness}
          action={{ kind: "review", href: buildSourcesRoute(selectedProfileId) }}
        />
      )}

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to review this plan."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : selectedProfileId == null ? (
        <EmptyState
          icon={Package}
          title="No plan selected"
          description="Choose a plan in the header or create one to validate parts and quantities."
        />
      ) : loading && !review ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading parts…</p>
          </CardContent>
        </Card>
      ) : review ? (
        <>
          <StlSyncBanner
            mode={stlBanner}
            onSync={runStlSync}
            syncDisabled={stlSyncBusy || syncJob.busy}
          />

          {(mergeConflicts.length > 0 || blockers.length > 0 || warnings.length > 0) && (
            <section className="section-card space-y-3">
              <h2 className="text-sm font-semibold">Issues</h2>
              {mergeConflicts.length > 0 && (
                <div
                  className="flex gap-2 rounded-md border border-warning bg-warning/15 px-3 py-2.5 text-sm"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
                  <div>
                    <p className="font-medium">
                      Duplicate parts detected ({mergeConflicts.length} conflict
                      {mergeConflicts.length === 1 ? "" : "s"})
                    </p>
                    <p className="mt-1 text-muted-foreground">{PARTS_CONFLICT_HINT}</p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {mergeConflictGroups.map(([filename, count]) => (
                        <li key={filename} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-foreground">{filename}</span>
                          <span className="text-muted-foreground">
                            — {count} variant{count === 1 ? "" : "s"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      to={buildSourcesRoute(selectedProfileId)}
                      className="mt-2 inline-block text-xs text-primary underline"
                    >
                      {PARTS_CONFLICT_CTA}
                    </Link>
                  </div>
                </div>
              )}
              {blockers.map((issue, i) => (
                <div
                  key={`b-${i}`}
                  className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                >
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  <div>
                    <p>{issue.message}</p>
                    {issue.link_hint && hintRoute(issue.link_hint, selectedProfileId) && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Link
                          to={hintRoute(issue.link_hint, selectedProfileId)!}
                          className="text-xs text-primary underline"
                        >
                          {issue.link_hint === "sources" ? "Go to Library" : "Fix on Plan"}
                        </Link>
                        {issue.link_hint === "sources" &&
                          review.layers.some((l) => !l.synced) && (
                            <button
                              type="button"
                              className="text-xs text-primary underline"
                              onClick={syncUnsyncedLayers}
                              disabled={stlSyncBusy || syncJob.busy}
                            >
                              {stlSyncBusy || syncJob.busy ? "Syncing…" : "Sync sources"}
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {warnings
                .filter((i) => i.code !== "merge_conflict")
                .map((issue, i) => (
                  <div
                    key={`w-${i}`}
                    className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                    <div>
                      <p>{issue.message}</p>
                      {issue.link_hint && hintRoute(issue.link_hint, selectedProfileId) && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          <Link
                            to={hintRoute(issue.link_hint, selectedProfileId)!}
                            className="text-xs text-primary underline"
                          >
                            {issue.link_hint === "sources" ? "Go to Library" : "Fix on Plan"}
                          </Link>
                          {issue.link_hint === "sources" &&
                            review.layers.some((l) => !l.synced) && (
                              <button
                                type="button"
                                className="text-xs text-primary underline"
                                onClick={syncUnsyncedLayers}
                                disabled={stlSyncBusy || syncJob.busy}
                              >
                                {stlSyncBusy || syncJob.busy ? "Syncing…" : "Sync sources"}
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </section>
          )}

          <section className="section-card">
            <h2 className="mb-2 text-sm font-semibold">Sources</h2>
            <ul className="space-y-2 text-sm">
              {review.layers.map((layer) => (
                <li key={layer.id} className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={layer.layer_type === "base" ? "base" : "addon"}
                    icon={layer.layer_type === "base" ? Layers : Box}
                  >
                    {layer.layer_type}
                  </Badge>
                  <span>{layer.project_name ?? "—"}</span>
                  {layer.synced ? (
                    <Badge variant="success" icon={RefreshCw}>
                      synced
                    </Badge>
                  ) : (
                    <Badge variant="warning" icon={AlertTriangle}>
                      not synced
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <ReviewPartsSheet
            ref={sheetRef}
            review={review}
            planName={planName}
            disabled={!engineReady || loading}
            folderRules={folderRules}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className="min-h-10 w-full sm:w-auto" variant="ghost" asChild>
              <Link to={buildSourcesRoute(selectedProfileId)}>Back to Sources</Link>
            </Button>
            <Button className="min-h-10 w-full sm:w-auto" variant="secondary" asChild>
              <Link to={exportRoute(selectedProfileId)}>Open Production</Link>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
