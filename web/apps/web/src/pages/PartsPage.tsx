import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";
import { Package, Printer } from "lucide-react";
import BuildSummaryHeader from "../components/build/BuildSummaryHeader";
import WorkingPlanReviewCard from "../components/build/WorkingPlanReviewCard";
import EmptyState from "../components/layout/EmptyState";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import PageShell from "../components/layout/PageShell";
import ReviewPartsSheet, {
  type ReviewPartsSheetHandle,
} from "../components/review/ReviewPartsSheet";
import {
  PlanAcceptanceProvider,
  usePlanAcceptance,
} from "../components/review/PlanAcceptanceContext";
import PlanAcceptanceActionCard from "../components/review/PlanAcceptanceActionCard";
import PlanAcceptanceConfirmation from "../components/review/PlanAcceptanceConfirmation";
import PlanAcceptedRevisionCard from "../components/review/PlanAcceptedRevisionCard";
import PlanIssuesSection from "../components/review/PlanIssuesSection";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import type { StlNamingFolderRule } from "@print-partner/contracts";
import { startSync } from "../api/endpoints/jobs";
import { fetchStlNaming } from "../api/endpoints/stlNaming";
import { buildSourcesRoute, productionRoute, progressRoute } from "../lib/routes";
import { planHeaderSummary } from "../lib/planAcceptanceModel";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useJobRunner } from "../hooks/useJobRunner";
import { resolveEngineState } from "../lib/workflowState";

/** Accepted state, open working changes, then parts, then the one accept action. */
function PlanReviewSections({
  sheetRef,
  folderRules,
  disabled,
}: {
  sheetRef: RefObject<ReviewPartsSheetHandle | null>;
  folderRules: StlNamingFolderRule[];
  disabled: boolean;
}) {
  const { model, buildId } = usePlanAcceptance();
  const { review } = usePlanWorkspace();
  const { profiles } = useProfileSelection();
  if (!review) return null;
  const planName = profiles.find((p) => p.id === buildId)?.name ?? review.plan_name ?? "Plan";

  return (
    <>
      <PlanAcceptedRevisionCard />
      <WorkingPlanReviewCard />
      <PlanIssuesSection />

      <section id="plan-parts" aria-labelledby="plan-parts-heading" className="space-y-2">
        <div>
          <h2 id="plan-parts-heading" className="text-sm font-semibold">
            Parts and quantities
          </h2>
          {!model.working && (
            <p className="text-sm text-muted-foreground">
              These are the values of the Accepted revision.
            </p>
          )}
        </div>
        <ReviewPartsSheet
          ref={sheetRef}
          review={review}
          planName={planName}
          disabled={disabled}
          folderRules={folderRules}
        />
      </section>

      <PlanAcceptanceActionCard />

      <section aria-labelledby="plan-downstream-heading" className="space-y-2 print:hidden">
        <h2 id="plan-downstream-heading" className="text-sm font-semibold">
          Where this work continues
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {model.downstream.map((link) => (
            <Button
              key={link.id}
              className="min-h-11 w-full sm:w-auto"
              variant={link.qualifier || link.id === "checkoff" ? "secondary" : "default"}
              asChild
            >
              <Link to={link.id === "production" ? productionRoute(buildId) : progressRoute(buildId)}>
                {link.qualifier ? `${link.label} (${link.qualifier})` : link.label}
              </Link>
            </Button>
          ))}
          <Button className="min-h-11 w-full sm:w-auto" variant="ghost" asChild>
            <Link to={buildSourcesRoute(buildId)}>Back to Sources</Link>
          </Button>
        </div>
      </section>
    </>
  );
}

/**
 * Plan is the acceptance checkpoint.
 *
 * The page answers two questions in order. What does Production use right now?
 * What, if anything, must happen before a new revision can be accepted?
 */
export default function PartsPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const {
    review,
    loading,
    error: workspaceError,
    draftError,
    draftLoading,
    draftWorkspace,
    refresh,
  } = usePlanWorkspace();
  const syncJob = useJobRunner("sync");
  const sheetRef = useRef<ReviewPartsSheetHandle>(null);
  const [folderRules, setFolderRules] = useState<StlNamingFolderRule[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";

  useEffect(() => {
    void fetchStlNaming()
      .then((profile) => {
        setFolderRules(
          (profile.folder_rules ?? []).filter((r) => r.functional_class != null),
        );
      })
      .catch(() => {/* the functional-class filter is optional */});
  }, []);

  const syncSources = useCallback(() => {
    const unsynced = review?.layers.filter((l) => l.project_id != null) ?? [];
    const ids = [...new Set(unsynced.map((l) => l.project_id!).filter(Boolean))];
    if (ids.length === 0) return;
    setSyncError(null);
    void syncJob.runJob(
      () => startSync(ids),
      (snap) => {
        if (snap.status === "error") {
          setSyncError(snap.message || "Source sync failed. Try again.");
          return;
        }
        if (selectedProfileId != null) void refresh();
      },
    );
  }, [refresh, review, selectedProfileId, syncJob]);

  const headerSummary = useMemo(
    () => planHeaderSummary({ review, draft: draftWorkspace }),
    [draftWorkspace, review],
  );

  const hasParts = (draftWorkspace?.parts.length ?? 0) > 0
    || (review?.part_groups.some((group) => group.parts.length > 0) ?? false);

  const onPrint = useCallback(() => {
    void sheetRef.current?.print();
  }, []);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Prepare"
        icon={Package}
        accent
        title="Plan"
        description={headerSummary}
        actions={
          <PageHeaderActions>
            <Button
              variant="ghost"
              className="min-h-11 w-full sm:w-auto"
              onClick={onPrint}
              disabled={selectedProfileId == null || !hasParts}
            >
              <Printer className="mr-1 h-4 w-4" />
              Print
            </Button>
          </PageHeaderActions>
        }
      />

      <BuildSummaryHeader currentStageId="plan" />

      <PlanAcceptanceProvider
        onSyncSources={syncSources}
        syncBusy={syncJob.busy}
      >
        <PlanAcceptanceConfirmation />

        {workspaceError && (
          <p className="text-sm text-destructive" role="alert">{workspaceError}</p>
        )}
        {draftError && (
          <p className="text-sm text-destructive" role="alert">{draftError}</p>
        )}
        {syncError && (
          <p className="text-sm text-destructive" role="alert">{syncError}</p>
        )}

        {engineState !== "ready" ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">
                {engineState === "offline"
                  ? "Engine offline. Start the print-partner engine to review this Plan."
                  : "Connecting to the engine…"}
              </p>
            </CardContent>
          </Card>
        ) : selectedProfileId == null ? (
          <EmptyState
            icon={Package}
            title="No Build selected"
            description="Choose a Build in the header, or create one, to review its Plan."
          />
        ) : loading && !review ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Loading this Plan…</p>
            </CardContent>
          </Card>
        ) : review ? (
          <PlanReviewSections
            sheetRef={sheetRef}
            folderRules={folderRules}
            disabled={!engineReady || loading || draftLoading}
          />
        ) : null}
      </PlanAcceptanceProvider>
    </PageShell>
  );
}
