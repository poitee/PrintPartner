import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
// Lazy: pulls in three.js only after the app shell renders, keeping it
// out of the initial 913 KB index bundle.
const PartThumb = lazy(() => import("./parts/PartThumb"));
import { Button } from "./ui/button";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useFlushBuildPageSaves } from "../hooks/useFlushBuildPageSaves";
import { exportRoute, isExportPath, isSourcesPath, planRoute } from "../lib/routes";
import { cn } from "../lib/utils";
import { planPrintTotals } from "../lib/workflowStages";
import { countMissingStls } from "../lib/stlAutoSync";
import { useStlAutoSync } from "../context/StlAutoSyncContext";

const PLAN_TRAY_EXPANDED_KEY = "print-partner.plan-tray.expanded.v1";
const TRAY_THUMB_LIMIT = 6;
const TRAY_THUMB_PX = 34;

function readExpanded(): boolean {
  try {
    return sessionStorage.getItem(PLAN_TRAY_EXPANDED_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Short initials from an STL filename for thumb fallbacks. */
export function partFilenameInitials(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/i, "")
    .replace(/^\[[^\]]*\]_?/i, "")
    .trim();
  const tokens = base.split(/[_\-\s.]+/).filter((t) => t.length > 0);
  if (tokens.length >= 2) {
    return `${tokens[0]![0] ?? ""}${tokens[1]![0] ?? ""}`.toUpperCase() || "?";
  }
  const single = tokens[0] ?? base;
  return (single.slice(0, 2) || "?").toUpperCase();
}

/**
 * Docked plan summary tray — distinct from JobTray (async jobs).
 * Sets `--plan-tray-height` so JobTray can stack above it.
 *
 * Shows included-part thumbnails with qty badges, print progress, and
 * shortcuts into Export / Plan. Hidden on Export (design) and when no plan
 * is selected.
 */
export default function PlanTray() {
  const location = useLocation();
  const navigate = useNavigate();
  const flushBuildSaves = useFlushBuildPageSaves();
  const { profiles, selectedProfileId } = useProfileSelection();
  const { review, loading } = usePlanWorkspace();
  const { busy: stlSyncBusy } = useStlAutoSync();
  const [expanded, setExpanded] = useState(readExpanded);

  const selected = profiles.find((p) => p.id === selectedProfileId);
  const totals = planPrintTotals(review);
  const sourceCount = review?.layers?.length ?? 0;
  const missingStlCount = review
    ? countMissingStls(review.part_groups.flatMap((g) => g.parts))
    : 0;
  const otherWarnCount =
    (review?.issues?.filter((i) => i.code !== "missing_stl").length ?? 0) +
    (selected?.build_stale ? 1 : 0);

  const includedParts = useMemo(() => {
    if (!review) return [];
    return review.part_groups.flatMap((g) => g.parts).filter((p) => p.included);
  }, [review]);

  const thumbs = useMemo(
    () => includedParts.slice(0, TRAY_THUMB_LIMIT),
    [includedParts],
  );
  const overflowCount = Math.max(0, includedParts.length - thumbs.length);

  const partCount =
    totals.partCount > 0
      ? totals.partCount
      : selected != null && selected.part_count > 0
        ? selected.part_count
        : 0;
  const hasParts = partCount > 0 || thumbs.length > 0;

  // Design: hide on Export hub; also require an active plan.
  const visible =
    selectedProfileId != null &&
    selected != null &&
    !isExportPath(location.pathname);

  const trayHeight = !visible ? "0px" : expanded ? "3.75rem" : "2.25rem";

  useEffect(() => {
    document.documentElement.style.setProperty("--plan-tray-height", trayHeight);
    return () => {
      document.documentElement.style.setProperty("--plan-tray-height", "0px");
    };
  }, [trayHeight]);

  if (!visible) return null;

  const partLabel =
    partCount > 0
      ? `${partCount} part${partCount === 1 ? "" : "s"}`
      : loading
        ? "Loading…"
        : "No parts yet";

  const sourceLabel =
    sourceCount > 0
      ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
      : selected.build_stale
        ? "stale"
        : null;

  return (
    <footer
      className={cn(
        "plan-tray fixed bottom-[var(--mobile-stage-height,0px)] left-0 right-0 z-40 border-t border-border bg-card shadow-[0_-2px_12px_rgba(89,115,166,0.09)] print:hidden",
        "lg:bottom-0 lg:left-[var(--app-sidebar-width,14rem)]",
      )}
      style={{ height: trayHeight }}
      aria-label="Plan tray"
    >
      <div
        className={cn(
          "flex h-full items-center gap-3 px-3 sm:gap-4 sm:px-5",
          !expanded && "opacity-90",
        )}
      >
        <span className="hidden font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:inline">
          Plan tray
        </span>
        <div className="flex min-w-0 shrink items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{partLabel}</span>
          {sourceLabel ? (
            <span className="hidden font-mono text-[11.5px] text-muted-foreground md:inline">
              {sourceLabel}
            </span>
          ) : null}
        </div>

        {expanded && thumbs.length > 0 ? (
          <div className="hidden items-center gap-1.5 md:flex" aria-label="Included parts preview">
            {thumbs.map((part) => (
              <span
                key={part.id}
                className="relative block shrink-0"
                title={`${part.filename} ×${part.quantity_effective}`}
              >
                <Suspense fallback={<span style={{ display: "block", width: TRAY_THUMB_PX, height: TRAY_THUMB_PX }} />}>
                  <PartThumb
                    partId={part.id}
                    tintHex={part.filament_hex}
                    sizePx={TRAY_THUMB_PX}
                    eager
                    fallbackLabel={partFilenameInitials(part.filename)}
                  />
                </Suspense>
                <span className="absolute -bottom-0.5 -right-0.5 z-[1] rounded bg-foreground px-0.5 font-mono text-[9px] font-medium leading-tight text-background">
                  {part.quantity_effective}
                </span>
              </span>
            ))}
            {overflowCount > 0 ? (
              <span
                className="flex h-[34px] w-[34px] items-center justify-center rounded-[4px] border border-dashed border-border font-mono text-[10px] font-medium text-muted-foreground"
                title={`${overflowCount} more included parts`}
              >
                +{overflowCount}
              </span>
            ) : null}
          </div>
        ) : null}

        {expanded && !loading && !hasParts ? (
          <span className="hidden min-w-0 truncate text-[11.5px] text-muted-foreground md:inline">
            Pick STLs in Library or open Plan to assemble parts
          </span>
        ) : null}

        {stlSyncBusy ? null : missingStlCount > 0 ? (
          <div className="hidden items-center gap-1.5 rounded-md border border-amber-300/80 bg-amber-50 px-2.5 py-1 dark:border-amber-700/60 dark:bg-amber-950/40 sm:flex">
            <span className="inline-block h-1.5 w-1.5 rotate-45 bg-amber-600 dark:bg-amber-400" />
            <span className="text-[11.5px] text-amber-900 dark:text-amber-200">
              {missingStlCount} STL missing
            </span>
          </div>
        ) : otherWarnCount > 0 ? (
          <div className="hidden items-center gap-1.5 rounded-md border border-amber-300/80 bg-amber-50 px-2.5 py-1 dark:border-amber-700/60 dark:bg-amber-950/40 sm:flex">
            <span className="inline-block h-1.5 w-1.5 rotate-45 bg-amber-600 dark:bg-amber-400" />
            <span className="text-[11.5px] text-amber-900 dark:text-amber-200">
              {otherWarnCount} warning{otherWarnCount === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {totals.totalUnits > 0 ? (
            <span className="hidden font-mono text-[11.5px] text-muted-foreground sm:inline">
              {totals.printedUnits} / {totals.totalUnits} units printed
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="hidden h-8 sm:inline-flex"
            onClick={() => {
              const to = exportRoute(selectedProfileId);
              const destPath = to.split("?")[0] ?? to;
              const leavingSources =
                isSourcesPath(location.pathname) && !isSourcesPath(destPath);
              if (leavingSources) {
                void flushBuildSaves().then(() => {
                  navigate(to);
                });
                return;
              }
              navigate(to);
            }}
          >
            Export {'>'}
          </Button>
          <Button size="sm" className="h-8" asChild>
            <Link to={planRoute(selectedProfileId)}>Open plan →</Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={expanded ? "Collapse plan tray" : "Expand plan tray"}
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((prev) => {
                const next = !prev;
                try {
                  sessionStorage.setItem(PLAN_TRAY_EXPANDED_KEY, next ? "1" : "0");
                } catch {
                  /* ignore */
                }
                return next;
              });
            }}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </footer>
  );
}
