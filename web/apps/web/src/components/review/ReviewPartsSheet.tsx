import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PlanReview, ReviewPart, RoleFilamentRow, SpoolmanSpoolRow, StlNamingFolderRule } from "../../api/engine";
import { fetchSpoolmanSpools } from "../../api/engine";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { useSpoolmanEnabled } from "../../hooks/useSpoolmanEnabled";
import { groupCheckoffParts } from "../../lib/checkoffGroups";
import { formatCheckoffSummary } from "../../lib/checkoffProgress";
import { countPartWarnings, partWarningNote } from "../../lib/partWarnings";
import { groupPartsByRole, partSourceNote } from "../../lib/partsGroups";
import {
  collectReviewFacets,
  filterReviewParts,
} from "../../lib/reviewPartsFilter";
import {
  flattenReviewParts,
  sourceLabelFromLayer,
} from "../../lib/reviewParts";
import {
  loadPersistedReviewPartsUi,
  savePersistedReviewPartsUi,
  type PersistedReviewPartsUi,
  type ReviewViewMode,
} from "../../lib/persistedReviewPartsUi";
import { useProfileSelection } from "../../context/ProfileContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePlanReviewQuery } from "../../queries/planReview";
import { useRoleFilamentsQuery } from "../../queries/roleFilaments";
import { waitForSheetThumbnails } from "../../lib/waitForSheetThumbnails";
import PartPreviewDialog from "../parts/PartPreviewDialog";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import FilterSelect, { filterSelectOut, filterSelectValue } from "./FilterSelect";
import PartSpoolPicker from "../PartSpoolPicker";
import SpoolRemainingBadge from "../SpoolRemainingBadge";
import PartsGridCard from "./PartsGridCard";
import ReviewSheetMobileCard from "./ReviewSheetMobileCard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { cn } from "../../lib/utils";

type Props = {
  review: PlanReview;
  planName: string;
  disabled?: boolean;
  folderRules?: StlNamingFolderRule[];
};

export type ReviewPartsSheetHandle = {
  print: () => Promise<void>;
};

function QuantityStepper({
  part,
  disabled,
  onChange,
}: {
  part: ReviewPart;
  disabled?: boolean;
  onChange: (qty: number) => void;
}) {
  const qty = part.quantity_override ?? part.quantity_effective;
  const belowPrinted = part.printed_count > qty;
  return (
    <div className="qty-control flex flex-col items-start gap-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="qty-btn"
          disabled={disabled || qty <= 1}
          onClick={() => onChange(qty - 1)}
          aria-label={`Decrease quantity for ${part.filename}`}
        >
          −
        </button>
        <input
          type="number"
          className="qty-input"
          min={1}
          value={qty}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          aria-label={`Quantity for ${part.filename}`}
        />
        <button
          type="button"
          className="qty-btn"
          disabled={disabled}
          onClick={() => onChange(qty + 1)}
          aria-label={`Increase quantity for ${part.filename}`}
        >
          +
        </button>
      </div>
      {belowPrinted && (
        <span className="text-xs text-amber-600">
          {part.printed_count} unit{part.printed_count === 1 ? "" : "s"} already printed
        </span>
      )}
    </div>
  );
}

function ReviewSheetRow({
  part,
  viewMode,
  busy,
  compact,
  eager,
  note,
  noteWarn,
  spoolmanConfigured,
  roleFilaments,
  spools,
  spoolsLoading,
  onQtyChange,
  onRemove,
  onRestore,
  onSpoolChange,
  onToggleUnit,
  onPreview,
}: {
  part: ReviewPart;
  viewMode: ReviewViewMode;
  busy: boolean;
  compact: boolean;
  eager?: boolean;
  note: string;
  noteWarn: boolean;
  spoolmanConfigured: boolean;
  roleFilaments: RoleFilamentRow[];
  spools: SpoolmanSpoolRow[];
  spoolsLoading?: boolean;
  onQtyChange: (part: ReviewPart, qty: number) => void;
  onRemove: (part: ReviewPart) => void;
  onRestore: (part: ReviewPart) => void;
  onSpoolChange: (partId: number, spoolman_spool_id: string | null) => void;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
}) {
  const printDone =
    part.printed_count >= part.quantity_effective && part.quantity_effective > 0;

  if (viewMode === "print") {
    return (
      <tr className={cn("sheet-row", printDone && "sheet-row-done", !part.included && "opacity-70")}>
        <td className="sheet-cell-part">
          <div className="sheet-part">
            <PartThumbExpandButton
              part={part}
              compact={compact}
              eager={eager}
              onExpand={onPreview}
            />
            <div className="sheet-part-meta">
              <span className="sheet-filename" title={part.relative_path || part.filename}>
                {part.filename}
              </span>
              <span className="sheet-part-tags">
                {part.filament_hex && (
                  <span className="sheet-swatch" style={{ background: part.filament_hex }} />
                )}
                {part.filament_display && <span>{part.filament_display}</span>}
                <SpoolRemainingBadge part={part} />
                {part.role && <span className="sheet-role">{part.role}</span>}
                {!part.included && <span className="sheet-role">excluded</span>}
              </span>
            </div>
          </div>
        </td>
        <td className="sheet-cell-qty sheet-cell-qty-readonly">{part.quantity_effective}</td>
        <td className="sheet-cell-printed">
          <div className="sheet-units">
            {part.print_units.map((unitDone, idx) => (
              <label
                key={idx}
                className={cn("sheet-unit", unitDone && "sheet-unit-done")}
                title={`Unit #${idx + 1}`}
              >
                <input
                  type="checkbox"
                  checked={unitDone}
                  onChange={() => onToggleUnit(part, idx)}
                  disabled={busy || !part.included}
                />
                <span>{idx + 1}</span>
              </label>
            ))}
            <span className={cn("sheet-printed-count", printDone && "sheet-printed-done")}>
              <span className="sheet-printed-screen">
                {part.printed_count}/{part.quantity_effective}
              </span>
              <span className="sheet-printed-label" aria-hidden>
                {part.printed_count} of {part.quantity_effective}
              </span>
            </span>
          </div>
        </td>
        <td className="sheet-cell-notes">
          <span className={cn("text-xs", noteWarn ? "text-warning" : "text-muted-foreground")}>
            {note}
          </span>
        </td>
      </tr>
    );
  }

  return (
    <tr className={cn("sheet-row", !part.included && "opacity-70")}>
      <td className="sheet-cell-part">
        <div className="sheet-part">
          <PartThumbExpandButton
            part={part}
            compact={compact}
            eager={eager}
            onExpand={onPreview}
          />
          <div className="sheet-part-meta">
            <span className="sheet-filename" title={part.relative_path || part.filename}>
              {part.filename}
            </span>
            <span className="sheet-part-tags">
              {part.filament_hex && (
                <span className="sheet-swatch" style={{ background: part.filament_hex }} />
              )}
              {part.filament_display && <span>{part.filament_display}</span>}
              <SpoolRemainingBadge part={part} />
              {part.role && <span className="sheet-role">{part.role}</span>}
              {!part.included && <span className="sheet-role">excluded</span>}
            </span>
          </div>
        </div>
      </td>
      {spoolmanConfigured && (
        <td className="sheet-cell-spool">
          <PartSpoolPicker
            part={part}
            roleFilaments={roleFilaments}
            spools={spools}
            spoolsLoading={spoolsLoading}
            disabled={busy || !part.included}
            hideLabel
            onChange={onSpoolChange}
          />
        </td>
      )}
      <td className="sheet-cell-qty">
        <QuantityStepper
          part={part}
          disabled={busy || !part.included}
          onChange={(n) => onQtyChange(part, n)}
        />
      </td>
      <td className="sheet-cell-actions">
        {part.included ? (
          <Button
            type="button"
            variant="sheetRemove"
            size="sm"
            className="sheet-remove-btn"
            disabled={busy}
            onClick={() => onRemove(part)}
          >
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="sheetRestore"
            size="sm"
            className="sheet-restore-btn"
            disabled={busy}
            onClick={() => onRestore(part)}
          >
            Restore
          </Button>
        )}
      </td>
      <td className="sheet-cell-notes">
        <span className={cn("text-xs", noteWarn ? "text-warning" : "text-muted-foreground")}>
          {note}
        </span>
      </td>
    </tr>
  );
}

const ReviewPartsSheet = forwardRef<ReviewPartsSheetHandle, Props>(function ReviewPartsSheet(
  { review: includedReview, planName, disabled, folderRules },
  ref,
) {
  const { profiles } = useProfileSelection();
  const {
    draftWorkspace,
    setQuantity,
    setIncluded,
    setSpoolmanSpool,
    toggleUnit,
    busyPartId,
  } = usePlanWorkspace();
  const { configured: spoolmanConfigured, integrationId } = useSpoolmanEnabled();
  const [spools, setSpools] = useState<SpoolmanSpoolRow[]>([]);
  const [spoolsLoading, setSpoolsLoading] = useState(false);
  const persisted = useMemo(() => loadPersistedReviewPartsUi(), []);
  const [ui, setUi] = useState<PersistedReviewPartsUi>(persisted);
  const needsExcluded = ui.includedFilter !== "included";
  const excludedReviewQuery = usePlanReviewQuery(includedReview.profile_id, {
    includeExcluded: true,
    enabled: needsExcluded,
  });
  const review = needsExcluded
    ? excludedReviewQuery.data ?? includedReview
    : includedReview;
  const roleFilamentsQuery = useRoleFilamentsQuery(
    includedReview.profile_id,
    spoolmanConfigured && Boolean(integrationId),
  );
  const roleFilaments = roleFilamentsQuery.data ?? [];
  const [removeTarget, setRemoveTarget] = useState<ReviewPart | null>(null);
  const [previewPart, setPreviewPart] = useState<ReviewPart | null>(null);
  const [printPrep, setPrintPrep] = useState(false);
  const sheetArticleRef = useRef<HTMLElement>(null);
  const isMobileLayout = useMediaQuery("(max-width: 767px)");

  useImperativeHandle(
    ref,
    () => ({
      print: async () => {
        setPrintPrep(true);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const sheet = sheetArticleRef.current;
        if (sheet) await waitForSheetThumbnails(sheet);
        window.print();
        setPrintPrep(false);
      },
    }),
    [],
  );

  useEffect(() => {
    const onBeforePrint = () => setPrintPrep(true);
    const onAfterPrint = () => setPrintPrep(false);
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, []);

  useEffect(() => {
    savePersistedReviewPartsUi(ui);
  }, [ui]);

  useEffect(() => {
    if (!spoolmanConfigured || !integrationId) {
      setSpools([]);
      setSpoolsLoading(false);
      return;
    }
    let cancelled = false;
    setSpoolsLoading(true);
    void fetchSpoolmanSpools(integrationId)
      .then((spoolRows) => {
        if (!cancelled) setSpools(spoolRows);
      })
      .catch(() => {
        if (!cancelled) setSpools([]);
      })
      .finally(() => {
        if (!cancelled) setSpoolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spoolmanConfigured, integrationId]);

  const acceptedParts = useMemo(() => flattenReviewParts(review.part_groups), [review.part_groups]);
  const acceptedPartById = useMemo(
    () => new Map(acceptedParts.map((part) => [part.id, part])),
    [acceptedParts],
  );
  const draftPartByKey = useMemo(
    () => new Map((draftWorkspace?.parts ?? []).map((part) => [part.part_key, part])),
    [draftWorkspace],
  );
  const allParts = useMemo(() => {
    if (!draftWorkspace || ui.viewMode !== "edit") return acceptedParts;
    return acceptedParts.map((part) => {
      const proposed = draftPartByKey.get(part.match_key);
      return proposed
        ? {
            ...part,
            included: proposed.included,
            quantity_override: proposed.quantity_override,
            quantity_effective: proposed.quantity_effective,
          }
        : part;
    });
  }, [acceptedParts, draftPartByKey, draftWorkspace, ui.viewMode]);

  const facets = useMemo(() => collectReviewFacets(allParts), [allParts]);

  const filtered = useMemo(
    () => filterReviewParts(allParts, review, { ...ui, folderRules: folderRules ?? [] }),
    [allParts, review, ui, folderRules],
  );

  const warningCount = useMemo(
    () => countPartWarnings(allParts.filter((p) => p.included), review),
    [allParts, review],
  );

  const roleGroups = useMemo(() => groupPartsByRole(filtered), [filtered]);
  const sourceGroups = useMemo(() => groupCheckoffParts(filtered), [filtered]);

  const summary = useMemo(
    () => formatCheckoffSummary(acceptedParts.filter((p) => p.included)),
    [acceptedParts],
  );

  const patchUi = useCallback((patch: Partial<PersistedReviewPartsUi>) => {
    setUi((prev) => ({ ...prev, ...patch }));
  }, []);

  const onQtyChange = (part: ReviewPart, next: number) => {
    void setQuantity(part.id, part.match_key, next);
  };

  const onRemove = (part: ReviewPart) => setRemoveTarget(part);

  const confirmRemove = () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    void setIncluded(target.id, target.match_key, false);
  };

  const onRestore = (part: ReviewPart) => {
    void setIncluded(part.id, part.match_key, true);
  };

  const onSpoolChange = (partId: number, spoolman_spool_id: string | null) => {
    void setSpoolmanSpool(partId, spoolman_spool_id);
  };

  const onToggleUnit = useCallback(
    (part: ReviewPart, unitIndex: number) => {
      const next = !part.print_units[unitIndex];
      void toggleUnit(part.id, unitIndex, next);
    },
    [toggleUnit],
  );

  const noteForPart = useCallback(
    (part: ReviewPart) => {
      const warn = partWarningNote(part, review);
      const accepted = acceptedPartById.get(part.id);
      const proposedChange = draftWorkspace && accepted && (
        accepted.included !== part.included || accepted.quantity_effective !== part.quantity_effective
      )
        ? `Accepted: qty ${accepted.quantity_effective}, ${accepted.included ? "included" : "excluded"}`
        : null;
      return {
        note: [warn ?? partSourceNote(part), proposedChange].filter(Boolean).join("; "),
        noteWarn: warn != null,
      };
    },
    [acceptedPartById, draftWorkspace, review],
  );

  const displayName = planName || profiles.find((p) => p.id === review.profile_id)?.name || "Parts";
  const viewMode = ui.viewMode;
  const groupMode = ui.groupMode;
  const layoutMode = ui.layoutMode;
  const showGrid = layoutMode === "grid" && viewMode === "edit" && !printPrep;

  const renderPartTable = (parts: ReviewPart[]) => (
    <>
      {isMobileLayout && (
        <div className="checkoff-mobile-list no-print">
          {parts.map((part) => (
            <ReviewSheetMobileCard
              key={part.id}
              part={part}
              viewMode={viewMode}
              busy={busyPartId === part.id || Boolean(disabled)}
              spoolmanConfigured={spoolmanConfigured}
              roleFilaments={roleFilaments}
              spools={spools}
              spoolsLoading={spoolsLoading}
              onQtyChange={onQtyChange}
              onRemove={() => onRemove(part)}
              onRestore={() => onRestore(part)}
              onSpoolChange={onSpoolChange}
              onToggleUnit={onToggleUnit}
              onPreview={setPreviewPart}
            />
          ))}
        </div>
      )}
      <div
        className={cn(
          "sheet-table-wrap",
          isMobileLayout && "checkoff-print-table hidden print:block",
        )}
      >
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="sheet-cell-part">Part</th>
              {viewMode === "edit" && spoolmanConfigured && (
                <th className="sheet-cell-spool">Spool</th>
              )}
              <th className="sheet-cell-qty">
                {viewMode === "edit" && draftWorkspace ? "Proposed qty" : "Qty"}
              </th>
              {viewMode === "edit" ? (
                <th className="sheet-cell-actions">
                  {draftWorkspace ? "Proposed inclusion" : "Actions"}
                </th>
              ) : (
                <th className="sheet-cell-printed">Printed</th>
              )}
              <th className="sheet-cell-notes">Notes</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const { note, noteWarn } = noteForPart(part);
              return (
                <ReviewSheetRow
                  key={part.id}
                  part={part}
                  viewMode={viewMode}
                  busy={busyPartId === part.id || Boolean(disabled)}
                  compact={isMobileLayout || ui.compactMode}
                  eager={printPrep}
                  note={note}
                  noteWarn={noteWarn}
                  spoolmanConfigured={spoolmanConfigured}
                  roleFilaments={roleFilaments}
                  spools={spools}
                  spoolsLoading={spoolsLoading}
                  onQtyChange={onQtyChange}
                  onRemove={onRemove}
                  onRestore={onRestore}
                  onSpoolChange={onSpoolChange}
                  onToggleUnit={onToggleUnit}
                  onPreview={setPreviewPart}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  const renderPartGrid = (parts: ReviewPart[]) => (
    <div className="no-print grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {parts.map((part) => (
        <PartsGridCard
          key={part.id}
          part={part}
          review={review}
          busy={busyPartId === part.id || Boolean(disabled)}
          onQtyChange={onQtyChange}
          onPreview={setPreviewPart}
        />
      ))}
    </div>
  );

  return (
    <section className="space-y-3">
      {draftWorkspace && ui.viewMode === "edit" && (
        <p className="no-print rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          Quantity and inclusion controls show proposed draft values. Accepted Plan values and Checkoff stay unchanged until Apply.
        </p>
      )}
      <div className="no-print checkoff-sticky flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex flex-wrap gap-1 border-b border-transparent"
            role="group"
            aria-label="Part grouping"
          >
            <Button
              size="sm"
              variant={groupMode === "role" && !ui.issuesOnly ? "secondary" : "ghost"}
              aria-pressed={groupMode === "role" && !ui.issuesOnly}
              onClick={() => patchUi({ groupMode: "role", issuesOnly: false })}
              disabled={disabled}
            >
              By role
            </Button>
            <Button
              size="sm"
              variant={groupMode === "source" && !ui.issuesOnly ? "secondary" : "ghost"}
              aria-pressed={groupMode === "source" && !ui.issuesOnly}
              onClick={() => patchUi({ groupMode: "source", issuesOnly: false })}
              disabled={disabled}
            >
              By source
            </Button>
            <Button
              size="sm"
              variant={ui.issuesOnly ? "secondary" : "ghost"}
              aria-pressed={ui.issuesOnly}
              onClick={() => patchUi({ issuesOnly: true })}
              disabled={disabled}
            >
              Warnings only
              {warningCount > 0 && (
                <span className="ml-1 font-mono text-[11px] text-warning">{warningCount}</span>
              )}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Layout">
              <Button
                size="sm"
                className="rounded-none border-0"
                variant={layoutMode === "grid" ? "secondary" : "ghost"}
                aria-pressed={layoutMode === "grid"}
                onClick={() => patchUi({ layoutMode: "grid", viewMode: "edit" })}
                disabled={disabled}
              >
                Grid
              </Button>
              <Button
                size="sm"
                className="rounded-none border-0"
                variant={layoutMode === "table" ? "secondary" : "ghost"}
                aria-pressed={layoutMode === "table"}
                onClick={() => patchUi({ layoutMode: "table" })}
                disabled={disabled}
              >
                Table
              </Button>
            </div>
            {layoutMode === "table" && (
              <div className="flex gap-1" role="group" aria-label="View mode">
                <Button
                  size="sm"
                  variant={viewMode === "edit" ? "secondary" : "ghost"}
                  aria-pressed={viewMode === "edit"}
                  onClick={() => patchUi({ viewMode: "edit" })}
                  disabled={disabled}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === "print" ? "secondary" : "ghost"}
                  aria-pressed={viewMode === "print"}
                  onClick={() => patchUi({ viewMode: "print" })}
                  disabled={disabled}
                >
                  Print
                </Button>
              </div>
            )}
          </div>
        </div>
        {spoolmanConfigured && viewMode === "edit" && layoutMode === "table" && (
          <p className="text-xs text-muted-foreground">
            Spool column: optional override per part
          </p>
        )}

        <input
          type="search"
          aria-label="Search review parts"
          className="checkoff-search w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder="Search parts…"
          value={ui.search}
          onChange={(e) => patchUi({ search: e.target.value })}
          disabled={disabled}
        />

        <div className="flex flex-wrap gap-2">
          <FilterSelect
            aria-label="Print status"
            value={ui.printFilter}
            onValueChange={(v) =>
              patchUi({ printFilter: v as PersistedReviewPartsUi["printFilter"] })
            }
            options={[
              { value: "all", label: "Print: all" },
              { value: "missing", label: "Remaining" },
              { value: "partial", label: "Partial" },
              { value: "complete", label: "Complete" },
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Included filter"
            value={ui.includedFilter}
            onValueChange={(v) =>
              patchUi({ includedFilter: v as PersistedReviewPartsUi["includedFilter"] })
            }
            options={[
              { value: "included", label: "Included only" },
              { value: "excluded", label: "Excluded only" },
              { value: "all", label: "All parts" },
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Source layer"
            value={filterSelectOut(ui.sourceLayer)}
            onValueChange={(v) => patchUi({ sourceLayer: filterSelectValue(v) || null })}
            options={[
              { value: "__empty", label: "All sources" },
              ...facets.sourceLayers.map((layer) => ({
                value: layer,
                label: sourceLabelFromLayer(layer),
              })),
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Folder"
            value={filterSelectOut(ui.folder)}
            onValueChange={(v) => patchUi({ folder: filterSelectValue(v) || null })}
            options={[
              { value: "__empty", label: "All folders" },
              ...facets.folders.map((f) => ({ value: f, label: f })),
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Role"
            value={filterSelectOut(ui.role)}
            onValueChange={(v) => patchUi({ role: filterSelectValue(v) || null })}
            options={[
              { value: "__empty", label: "All roles" },
              ...facets.roles.map((r) => ({ value: r, label: r })),
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Filament"
            value={filterSelectOut(ui.filament)}
            onValueChange={(v) => patchUi({ filament: filterSelectValue(v) || null })}
            options={[
              { value: "__empty", label: "All filaments" },
              ...facets.filaments.map((f) => ({ value: f, label: f })),
            ]}
            disabled={disabled}
          />
          <FilterSelect
            aria-label="Sort"
            value={ui.sort}
            onValueChange={(v) => patchUi({ sort: v as PersistedReviewPartsUi["sort"] })}
            options={[
              { value: "folder", label: "Sort: folder" },
              { value: "filename", label: "Sort: filename" },
              { value: "qty", label: "Sort: quantity" },
            ]}
            disabled={disabled}
          />
          {folderRules && folderRules.length > 0 && (
            <FilterSelect
              aria-label="Functional class"
              value={ui.functionalFilter}
              onValueChange={(v) =>
                patchUi({ functionalFilter: v as PersistedReviewPartsUi["functionalFilter"] })
              }
              options={[
                { value: "all", label: "Show: all" },
                { value: "functional", label: "Functional" },
                { value: "cosmetic", label: "Cosmetic" },
              ]}
              disabled={disabled}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          {!isMobileLayout && layoutMode === "table" && (
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={ui.compactMode}
                onChange={(e) => patchUi({ compactMode: e.target.checked })}
              />
              Compact rows
            </label>
          )}
          <span className="text-muted-foreground">{summary}</span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No parts match the current filters.</p>
      ) : (
        <article
          ref={sheetArticleRef}
          className={cn(
            "checkoff-sheet",
            ui.compactMode && !isMobileLayout && "compact",
            isMobileLayout && "checkoff-sheet-mobile",
            printPrep && "checkoff-sheet-print-continuous",
          )}
        >
          <header className="sheet-header">
            <h2 className="sheet-title">{displayName}</h2>
            <p className="sheet-subtitle">
              {filtered.length} part{filtered.length === 1 ? "" : "s"} · {summary}
            </p>
          </header>

          {groupMode === "role" || ui.issuesOnly ? (
            <div className="space-y-4">
              {roleGroups.map((group) => (
                <section key={group.roleKey} className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="inline-block h-4 w-4 shrink-0 rounded-sm border border-border"
                      style={{ background: group.hex || "var(--muted)" }}
                      aria-hidden
                    />
                    <h3 className="text-sm font-semibold">{group.title}</h3>
                    <span className="font-mono text-[11.5px] text-muted-foreground">
                      {group.meta}
                    </span>
                  </div>
                  {showGrid ? renderPartGrid(group.parts) : renderPartTable(group.parts)}
                </section>
              ))}
            </div>
          ) : (
            sourceGroups.map((repo) => (
              <section key={repo.repoLayer} className="sheet-repo">
                <h3 className="sheet-repo-title">
                  {repo.repoLabel}
                  <span className="sheet-repo-count">{repo.partCount}</span>
                </h3>
                {repo.folders.map((group) => (
                  <div key={group.folder} className="sheet-folder space-y-2.5">
                    <h4 className="sheet-folder-title">{group.folder}</h4>
                    {showGrid ? renderPartGrid(group.parts) : renderPartTable(group.parts)}
                  </div>
                ))}
              </section>
            ))
          )}
        </article>
      )}

      <Dialog open={removeTarget != null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove from build?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {removeTarget
              ? `Exclude “${removeTarget.filename}” from this plan? Use the Included filter to restore it later.`
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button variant="ghost" disabled={busyPartId != null} onClick={() => void confirmRemove()}>
              {busyPartId != null ? "Saving…" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <PartPreviewDialog part={previewPart} onClose={() => setPreviewPart(null)} />
    </section>
  );
});

export default ReviewPartsSheet;
