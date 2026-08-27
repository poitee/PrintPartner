import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import {
  parseDirectExportJobResult,
  type RequiredUnitToken,
} from "@print-partner/contracts";
import type { RoleFilamentRow } from "../../api/endpoints/filaments";
import { startExportStlPack, type StlPackGroupBy } from "../../api/endpoints/jobs";
import { startDirectExport } from "../../api/endpoints/acceptedPlates";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { useProfileSelection } from "../../context/ProfileContext";
import { useEngineHealth } from "../../hooks/useEngineHealth";
import { useJobRunner } from "../../hooks/useJobRunner";
import { checkoffUnitTotals } from "../../lib/checkoffProgress";
import { directExportTokensFromWorkspace } from "../../lib/directExportTokens";
import { completeExportDownload } from "../../lib/exportActions";
import { slicerExportGates } from "../../lib/exportActionGates";
import { handleStlPackExportJobDone } from "../../lib/exportStlJobResult";
import { planHasUnsetRoleColors } from "../../lib/roleColorSet";
import { flattenReviewParts } from "../../lib/reviewParts";
import { useAcceptedPlateWorkspaceQuery } from "../../queries/acceptedPlates";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import DirectExportCard from "./DirectExportCard";

type Props = Readonly<{
  onShare: () => void;
  roleFilaments?: RoleFilamentRow[];
  selectedTokens?: readonly RequiredUnitToken[];
}>;

export default function ExportActionCards({
  onShare,
  roleFilaments = [],
  selectedTokens,
}: Props) {
  const { health } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const { review } = usePlanWorkspace();
  const exportStlJob = useJobRunner("stl-export", selectedProfileId);
  const exportDirectJob = useJobRunner("export-direct-3mf", selectedProfileId);
  const workspace = useAcceptedPlateWorkspaceQuery(
    selectedProfileId,
    selectedProfileId != null && Boolean(health),
  );
  const directTokens = selectedTokens ?? directExportTokensFromWorkspace(workspace.data);
  const includedParts = review
    ? flattenReviewParts(review.part_groups).filter((part) => part.included)
    : [];
  const includedCount = includedParts.length;
  const remainingUnits = checkoffUnitTotals(includedParts).remainingUnits;
  const colorsUnset = planHasUnsetRoleColors(roleFilaments);
  const { canExportParts, canExportRemaining } = slicerExportGates({
    profileSelected: selectedProfileId != null,
    engineOk: Boolean(health),
    hasReview: Boolean(review),
    includedCount,
    remainingUnits,
  });

  const exportStls = (groupBy: StlPackGroupBy, missingOnly: boolean) => {
    if (selectedProfileId == null) return;
    void exportStlJob.runJob(
      () => startExportStlPack(selectedProfileId, {
        group_by: groupBy,
        ...(missingOnly ? { missing_only: true } : {}),
      }),
      (snapshot) => handleStlPackExportJobDone(
        missingOnly ? "Export remaining" : "STL export",
        snapshot,
        { pathField: "root_path" },
      ),
      { profileId: selectedProfileId },
    );
  };

  const exportDirect3mf = () => {
    if (selectedProfileId == null || directTokens.length === 0) return;
    void exportDirectJob.runJob(
      () => startDirectExport({ profile_id: selectedProfileId, tokens: [...directTokens] }),
      (snapshot) => {
        if (snapshot.status === "error") {
          toast.error(snapshot.message || "Direct 3MF failed");
          return;
        }
        try {
          const result = parseDirectExportJobResult(snapshot.result);
          completeExportDownload("Direct 3MF", result, { suggestedFilename: result.filename });
        } catch {
          toast.error("Direct 3MF failed");
        }
      },
      { profileId: selectedProfileId },
    );
  };

  const cards = [
    {
      key: "remaining",
      title: `Export remaining ${remainingUnits}`,
      description: "Unprinted STL units from this Build's Checkoff state.",
      chips: [remainingUnits > 0 ? `${remainingUnits} units` : "none remaining", "this Build"],
      disabled: !canExportRemaining,
      action: (groupBy: StlPackGroupBy) => exportStls(groupBy, true),
    },
    {
      key: "stls",
      title: "Export STLs",
      description: "Every included part, organized by role and Source folder.",
      chips: ["by role", "flat or nested"],
      disabled: !canExportParts,
      action: (groupBy: StlPackGroupBy) => exportStls(groupBy, false),
    },
  ];

  return (
    <div className="space-y-2">
      {colorsUnset ? <p className="text-xs text-muted-foreground">Colors remain Unassigned on the Plan.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <DirectExportCard
          tokenCount={directTokens.length}
          busy={exportDirectJob.busy}
          onExport={exportDirect3mf}
        />
        {cards.map((card) => (
          <Card key={card.key} className="flex flex-col border-border shadow-sm">
            <CardHeader className="space-y-2 pb-2">
              <CardTitle level={3} className="text-sm font-semibold leading-snug">{card.title}</CardTitle>
              <CardDescription className="text-xs leading-relaxed">{card.description}</CardDescription>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {card.chips.map((chip) => (
                  <Badge key={chip} variant="muted" className="rounded-full px-2 py-0.5 font-mono text-2xs font-normal">
                    {chip}
                  </Badge>
                ))}
              </div>
            </CardHeader>
            <CardContent className="mt-auto pt-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={card.disabled || exportStlJob.busy} loading={exportStlJob.busy} className="gap-1">
                    {exportStlJob.busy ? "Exporting…" : card.title}
                    {!exportStlJob.busy ? <ChevronDown className="h-3.5 w-3.5" /> : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Group exported files by</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => card.action("color_dir")}>Color and Source directory</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => card.action("color")}>Color only</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        ))}
        <Card className="flex flex-col border-border shadow-sm">
          <CardHeader className="space-y-2 pb-2">
            <CardTitle level={3} className="text-sm font-semibold leading-snug">Share Plan</CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              Sources, choices, roles, and quantities. STL files stay private.
            </CardDescription>
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <Badge variant="muted" className="rounded-full px-2 py-0.5 font-mono text-2xs font-normal">no STLs</Badge>
            </div>
          </CardHeader>
          <CardContent className="mt-auto pt-1">
            <Button size="sm" variant="outline" disabled={selectedProfileId == null} onClick={onShare}>Create bundle</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
