import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Package, Printer } from "lucide-react";
import type { StlNamingFolderRule } from "@print-partner/contracts";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import EmptyState from "../components/layout/EmptyState";
import PlanRolesCard from "../components/build/PlanRolesCard";
import KitManifestOptions from "../components/KitManifestOptions";
import PlanFileSelection from "../components/review/PlanFileSelection";
import PlanProgressChoices from "../components/review/PlanProgressChoices";
import ReviewPartsSheet, { type ReviewPartsSheetHandle } from "../components/review/ReviewPartsSheet";
import { Button } from "../components/ui/button";
import { fetchStlNaming } from "../api/endpoints/stlNaming";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { usePlanLayersQuery } from "../queries/planLayers";
import { buildSourcesRoute, productionRoute, progressRoute } from "../lib/routes";
import { statusTone } from "../lib/statusTone";
import { cn } from "../lib/utils";

export default function PartsPage() {
  const { selectedProfileId } = useProfileSelection();
  const { review, loading, error, draftError, draftWorkspace, draftLoading, preparePlan, saving, refresh, mergeConflict, discardPendingEdits } = usePlanWorkspace();
  const layers = usePlanLayersQuery(selectedProfileId);
  const sheetRef = useRef<ReviewPartsSheetHandle>(null);
  const prepared = useRef<number | null>(null);
  const [folderRules, setFolderRules] = useState<StlNamingFolderRule[]>([]);
  const hasSources = layers.data?.some((layer) => layer.project_id != null) ?? false;

  useEffect(() => {
    void fetchStlNaming().then((profile) => setFolderRules(profile.folder_rules ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedProfileId == null || !review || loading || draftLoading || !hasSources) return;
    if (prepared.current === selectedProfileId) return;
    prepared.current = selectedProfileId;
    void preparePlan().catch(() => {});
  }, [draftLoading, hasSources, loading, preparePlan, review, selectedProfileId]);

  const disabled = saving || loading || draftLoading;
  return (
    <PageShell>
      <PageHeader
        eyebrow="Prepare"
        icon={Package}
        title="Plan"
        description="Choose files, quantities, and colors for this Build."
        actions={
          <div className="flex items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {saving ? "Saving…" : draftError ? "Not saved" : review?.accepted_basis ? "Saved" : ""}
            </span>
            <Button variant="ghost" disabled={!review?.accepted_basis || disabled} onClick={() => void sheetRef.current?.print()}>
              <Printer className="mr-1 h-4 w-4" /> Print
            </Button>
          </div>
        }
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {draftError && (
        <div role="alert" className={cn("space-y-2 rounded-lg border p-4", statusTone({ tone: "error", emphasis: "soft" }))}>
          <p className="text-sm">{draftError}</p>
          {mergeConflict && (
            <div className="space-y-2">
              <p className="text-sm">Your pending choices remain below. To start from the latest saved Plan, discard these pending edits and make your changes again. Finished print progress is kept.</p>
              <Button variant="secondary" disabled={saving} onClick={() => void discardPendingEdits().catch(() => {})}>Discard pending edits and use saved Plan</Button>
            </div>
          )}
          <Button variant="secondary" disabled={saving} onClick={() => void preparePlan().catch(() => {})}>Retry save</Button>
        </div>
      )}
      {draftWorkspace && <PlanProgressChoices key={`${draftWorkspace.profile_id}:${draftWorkspace.draft.snapshot_digest}`} workspace={draftWorkspace} />}
      {selectedProfileId == null ? (
        <EmptyState icon={Package} title="No Build selected" description="Choose a Build to edit its Plan." />
      ) : !hasSources && !layers.isLoading ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Add a source from the Library to get started.</p>
          <Button asChild><Link to={buildSourcesRoute(selectedProfileId)}>Add sources</Link></Button>
        </div>
      ) : !review?.accepted_basis ? (
        <p className="text-sm text-muted-foreground">{saving || loading || draftLoading ? "Loading your files…" : "Your files will appear here once the sources are ready."}</p>
      ) : (
        <>
          <KitManifestOptions profileId={selectedProfileId} disabled={disabled} onUpdated={() => preparePlan({ applyManifest: true })} compact />
          <PlanFileSelection profileId={selectedProfileId} disabled={disabled} />
          <section id="materials" className="space-y-2">
            <h2 className="text-sm font-semibold">Colors and materials</h2>
            <PlanRolesCard profileId={selectedProfileId} refreshKey={review.accepted_basis.plan_version} disabled={disabled} onUpdated={refresh} />
          </section>
          <section id="plan-parts" className="space-y-2">
            <h2 className="text-sm font-semibold">Parts and quantities</h2>
            <ReviewPartsSheet ref={sheetRef} review={review} planName={review.plan_name} folderRules={folderRules} disabled={disabled} />
          </section>
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild><Link to={productionRoute(selectedProfileId)}>Open Production</Link></Button>
            <Button variant="secondary" asChild><Link to={progressRoute(selectedProfileId)}>Open Checkoff</Link></Button>
          </div>
        </>
      )}
    </PageShell>
  );
}
