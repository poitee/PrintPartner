import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import {
  dismissPrinterCheckoff,
  fetchPrinterCheckoffLinks,
  verifyPrinterCheckoff,
  type PrintRejectReason,
  type PrinterCheckoffLink,
  type ReviewPart,
} from "../../api/engine";
import {
  buildPreviewRowsFromUnits,
  type ObjectPreviewRow,
} from "../../lib/proposeCheckoffFromObjects";
import ObjectProposalRows from "../export/ObjectProposalRows";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

const REJECT_REASONS: { value: PrintRejectReason; label: string }[] = [
  { value: "bed_adhesion", label: "Bed adhesion" },
  { value: "layer_shift", label: "Layer shift" },
  { value: "warping", label: "Warping" },
  { value: "stringing", label: "Stringing" },
  { value: "under_extrusion", label: "Under-extrusion" },
  { value: "over_extrusion", label: "Over-extrusion" },
  { value: "dimensional", label: "Dimensional" },
  { value: "collision", label: "Collision / knock" },
  { value: "wrong_filament", label: "Wrong filament" },
  { value: "other", label: "Other" },
];

export type PrintVerifyQueueState = {
  awaitingCount: number;
  watchingCount: number;
  /** Host name for the first awaiting_verify link (header copy). */
  primaryHostName: string | null;
};

type Props = {
  engineReady: boolean;
  profileId: number | null;
  parts: ReviewPart[];
  refreshKey?: number;
  onVerified?: () => void;
  onQueueChange?: (state: PrintVerifyQueueState) => void;
  /**
   * Hosts still printing/paused — suppress Confirm/Reject only for links on
   * those integration ids. Watching links still show proposal + printing note.
   */
  suppressIntegrationIds?: ReadonlySet<string>;
  className?: string;
};

function unitKey(partId: number, unitIndex: number): string {
  return `${partId}:${unitIndex}`;
}

function pendingUnits(link: PrinterCheckoffLink) {
  const done = new Set(
    (link.resolved_units ?? []).map((u) => unitKey(u.part_id, u.unit_index)),
  );
  return link.units.filter((u) => !done.has(unitKey(u.part_id, u.unit_index)));
}

function linkPreviewRows(link: PrinterCheckoffLink, parts: ReviewPart[]): ObjectPreviewRow[] {
  const unlabeled = (link.unlabeled_names ?? []).filter((n) => typeof n === "string" && n.trim());
  return buildPreviewRowsFromUnits(pendingUnits(link), parts, unlabeled);
}

/**
 * Verify-first Progress hero:
 * - Watching (during print): same named-object rows + per-row `printing` — no Confirm/Reject.
 * - Awaiting verify (after finish): Confirm / Reject marks proposed units (never auto-tick).
 * Unlabeled rows (if present) are visible but never in the confirm set.
 */
const EMPTY_SUPPRESS_IDS: ReadonlySet<string> = new Set();

export default function PrintVerifyPanel({
  engineReady,
  profileId,
  parts,
  refreshKey = 0,
  onVerified,
  onQueueChange,
  suppressIntegrationIds,
  className,
}: Props) {
  const [watchingLinks, setWatchingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [links, setLinks] = useState<PrinterCheckoffLink[]>([]);
  const [failedLinks, setFailedLinks] = useState<PrinterCheckoffLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<{
    linkId: string;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState<PrintRejectReason>("bed_adhesion");
  const [rejectNote, setRejectNote] = useState("");
  const onQueueChangeRef = useRef(onQueueChange);
  onQueueChangeRef.current = onQueueChange;

  const suppressedHosts = suppressIntegrationIds ?? EMPTY_SUPPRESS_IDS;

  const reload = useCallback(async () => {
    if (!engineReady || profileId == null) {
      setWatchingLinks([]);
      setLinks([]);
      setFailedLinks([]);
      return;
    }
    try {
      const [watching, awaiting, failed] = await Promise.all([
        fetchPrinterCheckoffLinks({ state: "watching", profile_id: profileId }),
        fetchPrinterCheckoffLinks({ state: "awaiting_verify", profile_id: profileId }),
        fetchPrinterCheckoffLinks({ state: "host_failed", profile_id: profileId }),
      ]);
      setWatchingLinks(watching.links);
      setLinks(awaiting.links);
      setFailedLinks(failed.links);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [engineReady, profileId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    onQueueChangeRef.current?.({
      awaitingCount: links.length,
      watchingCount: watchingLinks.length,
      primaryHostName: links[0]?.host_name ?? watchingLinks[0]?.host_name ?? null,
    });
  }, [links, watchingLinks]);

  useEffect(() => {
    if (!rejectTarget) return;
    const target = links.find((l) => l.id === rejectTarget.linkId);
    if (target && suppressedHosts.has(target.integration_id)) {
      setRejectTarget(null);
    }
  }, [links, rejectTarget, suppressedHosts]);

  const runVerify = async (
    linkId: string,
    decisions: Parameters<typeof verifyPrinterCheckoff>[0]["decisions"],
  ) => {
    setBusy(true);
    try {
      const result = await verifyPrinterCheckoff({ link_id: linkId, decisions });
      if (result.units_confirmed > 0) {
        toast.success(
          `Confirmed ${result.units_confirmed} unit${result.units_confirmed === 1 ? "" : "s"} printed`,
        );
      }
      if (result.units_rejected > 0) {
        toast.message(
          `Logged ${result.units_rejected} reject${result.units_rejected === 1 ? "" : "s"}`,
        );
      }
      setRejectTarget(null);
      setRejectNote("");
      await reload();
      onVerified?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onConfirmAll = (link: PrinterCheckoffLink) => {
    const units = pendingUnits(link);
    if (!units.length) return;
    void runVerify(
      link.id,
      units.map((u) => ({
        part_id: u.part_id,
        unit_index: u.unit_index,
        result: "confirmed" as const,
      })),
    );
  };

  const onSubmitReject = () => {
    if (!rejectTarget) return;
    const link = links.find((l) => l.id === rejectTarget.linkId);
    if (!link) return;
    const units = pendingUnits(link);
    if (!units.length) return;
    void runVerify(
      link.id,
      units.map((u) => ({
        part_id: u.part_id,
        unit_index: u.unit_index,
        result: "rejected" as const,
        reason: rejectReason,
        note: rejectNote.trim() || undefined,
      })),
    );
  };

  const onDismissFailed = async (linkId: string) => {
    setBusy(true);
    try {
      await dismissPrinterCheckoff({ link_id: linkId });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!engineReady || profileId == null) return null;

  const showFailed = failedLinks.length > 0;
  const actionableLinks = links.filter((l) => !suppressedHosts.has(l.integration_id));
  const suppressedAwaiting = links.filter((l) => suppressedHosts.has(l.integration_id));
  // Watching links always show proposal + printing (Confirm suppressed until finish).
  const watchingForDisplay = watchingLinks.length > 0 ? watchingLinks : suppressedAwaiting;
  const showWatching = watchingForDisplay.length > 0;
  const showVerify = actionableLinks.length > 0;

  if (!showFailed && !showVerify && !showWatching) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-2 print:hidden", className)}>
      {failedLinks.map((link) => (
        <div
          key={link.id}
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 font-medium text-destructive">
              {link.host_name}{" "}
              {link.host_outcome === "cancelled" ? "cancelled" : "failed"}{" "}
              <span className="font-mono">{link.filename}</span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onDismissFailed(link.id)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ))}

      {/* DURING print: named-object rows + per-row printing only — no Confirm/Reject. */}
      {showWatching
        ? watchingForDisplay.map((link) => {
            const rows = linkPreviewRows(link, parts);
            if (!rows.length) return null;
            return (
              <div
                key={`watching:${link.id}`}
                className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-4 py-4 text-sm shadow-sm"
                role="status"
                aria-label={`Printing proposed parts from ${link.filename}`}
              >
                <div className="min-w-0 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Proposed from{" "}
                    <span className="font-mono text-foreground">{link.filename}</span>
                  </p>
                  <ObjectProposalRows rows={rows} printing />
                </div>
              </div>
            );
          })
        : null}

      {/* AFTER finish: Confirm / Reject hero (matched units only). */}
      {showVerify &&
        actionableLinks.map((link) => {
          const units = pendingUnits(link);
          const rows = linkPreviewRows(link, parts);
          return (
            <div
              key={link.id}
              className="rounded-lg border border-orange-500/35 bg-orange-500/5 px-4 py-4 text-sm shadow-sm"
              role="region"
              aria-label={`Confirm these parts from ${link.filename}`}
            >
              <div className="flex flex-col gap-3">
                <div className="min-w-0 space-y-2">
                  <p className="text-base font-semibold text-foreground">Confirm these parts</p>
                  <p className="text-sm text-muted-foreground">
                    Proposed from{" "}
                    <span className="font-mono text-foreground">{link.filename}</span>
                    . Confirm marks them printed. Reject leaves them remaining.
                  </p>
                  <ObjectProposalRows rows={rows} />
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="min-h-10"
                    disabled={busy || units.length === 0}
                    onClick={() => onConfirmAll(link)}
                  >
                    <Check className="mr-1 h-4 w-4" aria-hidden />
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-10"
                    disabled={busy || units.length === 0}
                    onClick={() => {
                      setRejectReason("bed_adhesion");
                      setRejectNote("");
                      setRejectTarget({ linkId: link.id });
                    }}
                  >
                    <X className="mr-1 h-4 w-4" aria-hidden />
                    Reject…
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

      {rejectTarget && showVerify && (
        <div
          className="rounded-lg border border-border bg-card px-3 py-3 text-sm shadow-sm"
          role="dialog"
          aria-label="Reject print units"
        >
          <p className="mb-2 font-medium">Why did these units fail?</p>
          <select
            className="mb-2 min-h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value as PrintRejectReason)}
            aria-label="Reject reason"
          >
            {REJECT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="mb-2 min-h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            placeholder="Optional note"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            maxLength={500}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={onSubmitReject}>
              Save reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setRejectTarget(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
