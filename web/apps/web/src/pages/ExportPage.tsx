import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileArchive } from "lucide-react";
import DeskNextStep from "../components/layout/DeskNextStep";
import PageHeader from "../components/layout/PageHeader";
import RouteBreadcrumbs from "../components/layout/RouteBreadcrumbs";
import ExportActionCards from "../components/export/ExportActionCards";
import ExportRecentPanel from "../components/export/ExportRecentPanel";
import PartsManifestTransfer from "../components/export/PartsManifestTransfer";
import ProductionSelectionPanel from "../components/export/ProductionSelectionPanel";
import ProductionRulesPanel from "../components/export/ProductionRulesPanel";
import SlicerLinksPanel from "../components/export/SlicerLinksPanel";
import SlicerHandoffPanel from "../components/export/SlicerHandoffPanel";
import AcceptedPlateSection from "../components/export/accepted-plates/AcceptedPlateSection";
// Lazy: PrinterSendPanel pulls in heavy printer integration + dnd-kit
const PrinterSendPanel = lazy(() => import("../components/export/PrinterSendPanel"));
import ShareBuildExportDialog from "../components/share/ShareBuildExportDialog";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useProductionSelection } from "../hooks/useProductionSelection";
import { useSourcesQuery } from "../queries/sources";
import { useRoleFilamentsQuery } from "../queries/roleFilaments";
import { useAcceptedPlateWorkspaceQuery } from "../queries/acceptedPlates";
import { checkoffUnitTotals } from "../lib/checkoffProgress";
import { deskNextStepLine } from "../lib/deskNextStep";
import { flattenReviewParts } from "../lib/reviewParts";
import { planRoute } from "../lib/routes";
import {
  clearProductionSelectionGroup,
  productionSelectableUnits,
  selectedProductionTokens,
  toggleProductionUnit,
} from "../lib/productionSelection";
import { cn } from "../lib/utils";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
  shouldMountPlanTools,
} from "../lib/workflowState";

/**
 * Export — printer Send panel binds to the active spine plan (GRE-232).
 * Slicer-input file cards (STL, 3MF, share, manifest) stay plan-gated below.
 * Farm-queue verbs (Send ready / Send now / Remove) live on Progress, not here.
 */
export default function ExportPage() {
  const [searchParams] = useSearchParams();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const {
    selectedProfileId,
    profiles,
    loading: profilesLoading,
    error: profilesError,
    reloadProfiles,
  } = useProfileSelection();
  const { review, refresh, loading, error: planError } =
    usePlanWorkspace();
  const { data: sources = [] } = useSourcesQuery();
  const [shareOpen, setShareOpen] = useState(false);
  const roleFilamentsQuery = useRoleFilamentsQuery(
    selectedProfileId,
    Boolean(health?.ok),
  );
  const roleFilaments = roleFilamentsQuery.data ?? [];
  const roleFilamentError = roleFilamentsQuery.error
    ? `Could not refresh filament assignments: ${
        roleFilamentsQuery.error instanceof Error
          ? roleFilamentsQuery.error.message
          : String(roleFilamentsQuery.error)
      }`
    : null;
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const profilesState = resolveResourceState({
    loading: profilesLoading,
    error: profilesError,
    hasData: profiles.length > 0,
  });
  const profilesBackgroundError = getBackgroundError(
    profilesError,
    profiles.length > 0,
  );
  const planToolsReady = shouldMountPlanTools(engineState, selectedProfileId);

  const planName =
    selectedProfileId != null
      ? profiles.find((p) => p.id === selectedProfileId)?.name
      : null;

  const includedParts = useMemo(() => {
    if (!review) return [];
    return flattenReviewParts(review.part_groups).filter((p) => p.included);
  }, [review]);
  const remainingParts = useMemo(
    () => includedParts.filter((p) => p.missing),
    [includedParts],
  );
  const remainingUnits = checkoffUnitTotals(includedParts).remainingUnits;
  const exportNextStep = deskNextStepLine("export", { remainingUnits });
  const workspaceQuery = useAcceptedPlateWorkspaceQuery(
    selectedProfileId,
    selectedProfileId != null && engineState === "ready",
  );
  const selectableUnits = useMemo(
    () => productionSelectableUnits(workspaceQuery.data ?? { kind: "empty_plan" }),
    [workspaceQuery.data],
  );
  const selectParam = searchParams.get("select");
  const { selection, setSelection, setupSaving, setupError } = useProductionSelection(
    selectableUnits,
    selectParam,
    selectedProfileId,
  );
  const selectedTokens = selectedProductionTokens(selectableUnits, selection);

  const planIdentity =
    planName && includedParts.length > 0
      ? `${planName} · ${includedParts.length} part${includedParts.length === 1 ? "" : "s"}`
      : planName;

  return (
    <div className="space-y-4">
      <RouteBreadcrumbs
        items={[
          { label: "Plan", to: planRoute(selectedProfileId) },
          { label: "Production" },
        ]}
      />
      <PageHeader
        icon={FileArchive}
        accent
        eyebrow={planIdentity}
        title="Production"
        description="Choose parts, arrange editable Plates, export to your slicer, then send sliced G-code to a printer."
      />
      <DeskNextStep>{exportNextStep}</DeskNextStep>

      {(profilesBackgroundError || roleFilamentError || (planError && review)) && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          {profilesBackgroundError && (
            <p>Could not refresh plans: {profilesBackgroundError}</p>
          )}
          {roleFilamentError && <p>{roleFilamentError}</p>}
          {planError && review && <p>Could not refresh this plan: {planError}</p>}
        </div>
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to export."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : profilesState === "error" ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load plans: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profilesState === "loading" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading plans…</p>
          </CardContent>
        </Card>
      ) : !planToolsReady ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Open a plan to send sliced files or export slicer input.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              1 · Choose slicer input
            </h2>

            <SlicerLinksPanel />
            {setupSaving ? <p className="text-xs text-muted-foreground" role="status">Saving production setup…</p> : null}
            {setupError ? (
              <p className="text-sm text-destructive" role="alert">
                Production choices could not be saved: {setupError instanceof Error ? setupError.message : String(setupError)}
              </p>
            ) : null}
            {selectableUnits.length > 0 ? (
              <ProductionSelectionPanel
                units={selectableUnits}
                selection={selection}
                onToggle={(token) => setSelection((current) => toggleProductionUnit(current, token))}
                onClearGroup={(field, value) => setSelection((current) =>
                  clearProductionSelectionGroup(current, selectableUnits, field, value)
                )}
                onSelectAll={() => setSelection(new Set(selectableUnits.map((unit) => unit.token)))}
                onSelectIncomplete={() => setSelection(new Set(
                  selectableUnits.filter((unit) => !unit.completed).map((unit) => unit.token),
                ))}
                onClearAll={() => setSelection(new Set())}
              />
            ) : null}
            <h2 className="pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              2 · Set grouping and arrange Plates
            </h2>
            {selectedProfileId != null ? <ProductionRulesPanel profileId={selectedProfileId} /> : null}
            {selectedProfileId != null ? (
              <AcceptedPlateSection
                profileId={selectedProfileId}
                enabled={engineState === "ready"}
                selectedTokens={new Set(selectedTokens)}
              />
            ) : null}
            <h2 className="pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              3 · Export the saved Plate layout
            </h2>
            <SlicerHandoffPanel />

            {loading && !review ? (
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">Loading plan…</p>
                </CardContent>
              </Card>
            ) : planError && !review ? (
              <Card>
                <CardContent className="pt-6 space-y-3">
                  <p className="text-sm text-destructive">
                    Could not load this plan: {planError}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (selectedProfileId != null) void refresh();
                    }}
                  >
                    Retry
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div
                className={cn(
                  "grid gap-4",
                  "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,18.75rem)]",
                )}
              >
                <div className="min-w-0">
                  <ExportActionCards
                    onShare={() => setShareOpen(true)}
                    roleFilaments={roleFilaments}
                    selectedTokens={selectedTokens}
                  />
                </div>
                <ExportRecentPanel />
              </div>
            )}

            <PartsManifestTransfer
              review={review}
              sources={sources}
              onApplied={async () => {
                await Promise.all([refresh(), roleFilamentsQuery.refetch()]);
              }}
            />
          </div>

          <div className="space-y-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              4 · Send sliced G-code
            </h2>
            <Suspense fallback={<div className="h-32 animate-pulse rounded-lg bg-muted" />}>
              <PrinterSendPanel
                remainingParts={remainingParts}
                profileId={selectedProfileId}
                planName={planName}
                engineReady={engineState === "ready"}
              />
            </Suspense>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to={planRoute(selectedProfileId)}>Back to Plan</Link>
            </Button>
          </div>
        </>
      )}

      {selectedProfileId != null && (
        <ShareBuildExportDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          profileId={selectedProfileId}
        />
      )}
    </div>
  );
}
