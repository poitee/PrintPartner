import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../queries/keys";
import { Check, X } from "lucide-react";
import {
  dismissPrinterCheckoff,
  fetchPrinterCheckoffLinks,
  verifyPrinterCheckoff,
  type PrintRejectReason,
  type PrinterCheckoffLink,
} from "../../api/endpoints/checkoff";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import {
  buildPreviewRowsFromUnits,
  type ObjectPreviewRow,
} from "../../lib/proposeCheckoffFromObjects";
import {
  checkoffLinkErrorKey,
  clearCheckoffRowError,
  describeCheckoffMutationFailure,
  getCheckoffRowError,
  NO_CHECKOFF_ROW_ERRORS,
  setCheckoffRowError,
  type CheckoffMutationAction,
  type CheckoffRowErrors,
} from "../../lib/checkoffConsoleRowErrors";
import { statusTone } from "../../lib/statusTone";
import ObjectProposalRows from "../export/ObjectProposalRows";
import CheckoffRowErrorNotice from "./CheckoffRowErrorNotice";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

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
  activityLinks?: {
    watching: PrinterCheckoffLink[];
    awaiting: PrinterCheckoffLink[];
    failed: PrinterCheckoffLink[];
  };
  onActivityRefresh?: () => void | Promise<void>;
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
  activityLinks,
  onActivityRefresh,
  onVerified,
  onQueueChange,
  suppressIntegrationIds,
  className,
}: Props) {
  const queryClient = useQueryClient();
  const [watchingLinks, setWatchingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [links, setLinks] = useState<PrinterCheckoffLink[]>([]);
  const [failedLinks, setFailedLinks] = useState<PrinterCheckoffLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<{
    linkId: string;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState<PrintRejectReason>("bed_adhesion");
  const [rejectNote, setRejectNote] = useState("");
  /** Persistent per-job failures. A toast is gone before the operator reacts. */
  const [linkErrors, setLinkErrors] = useState<CheckoffRowErrors>(NO_CHECKOFF_ROW_ERRORS);
  const retryHandlers = useRef(new Map<string, () => void>());
  const [readError, setReadError] = useState<string | null>(null);
  /** Polite confirmation of the last verification, kept beside the queue. */
  const [notice, setNotice] = useState<string | null>(null);
  const onQueueChangeRef = useRef(onQueueChange);
  onQueueChangeRef.current = onQueueChange;

  const suppressedHosts = suppressIntegrationIds ?? EMPTY_SUPPRESS_IDS;

  const reload = useCallback(async () => {
    if (activityLinks) {
      await onActivityRefresh?.();
      return;
    }
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
      setReadError(null);
    } catch (e) {
      setReadError(
        `Could not read the verification queue: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [activityLinks, engineReady, onActivityRefresh, profileId]);

  useEffect(() => {
    if (activityLinks) return;
    void reload();
  }, [activityLinks, reload, refreshKey]);

  const displayWatchingLinks = activityLinks?.watching ?? watchingLinks;
  const displayLinks = activityLinks?.awaiting ?? links;
  const displayFailedLinks = activityLinks?.failed ?? failedLinks;

  useEffect(() => {
    onQueueChangeRef.current?.({
      awaitingCount: displayLinks.length,
      watchingCount: displayWatchingLinks.length,
      primaryHostName: displayLinks[0]?.host_name ?? displayWatchingLinks[0]?.host_name ?? null,
    });
  }, [displayLinks, displayWatchingLinks]);

  useEffect(() => {
    if (!rejectTarget) return;
    const target = displayLinks.find((l) => l.id === rejectTarget.linkId);
    if (target && suppressedHosts.has(target.integration_id)) {
      setRejectTarget(null);
    }
  }, [displayLinks, rejectTarget, suppressedHosts]);

  const recordFailure = (input: {
    linkId: string;
    filename: string;
    action: CheckoffMutationAction;
    cause: unknown;
    retry: () => void;
  }) => {
    retryHandlers.current.set(input.linkId, input.retry);
    setLinkErrors((errors) =>
      setCheckoffRowError(errors, checkoffLinkErrorKey(input.linkId), {
        message: describeCheckoffMutationFailure({
          action: input.action,
          filename: input.filename,
          cause: input.cause,
        }),
        retryLabel: "Retry",
        at: new Date().toISOString(),
      }),
    );
  };

  const clearFailure = (linkId: string) => {
    retryHandlers.current.delete(linkId);
    setLinkErrors((errors) => clearCheckoffRowError(errors, checkoffLinkErrorKey(linkId)));
  };

  /**
   * Retry reruns the same decisions, so the operator keeps the reason and note
   * they already chose. It never restarts the verification.
   */
  const runVerify = async (
    link: PrinterCheckoffLink,
    decisions: Parameters<typeof verifyPrinterCheckoff>[0]["decisions"],
    action: CheckoffMutationAction,
  ) => {
    setBusy(true);
    try {
      const result = await verifyPrinterCheckoff({ link_id: link.id, decisions });
      const parts: string[] = [];
      if (result.units_confirmed > 0) {
        parts.push(
          `Confirmed ${result.units_confirmed} unit${result.units_confirmed === 1 ? "" : "s"} printed`,
        );
      }
      if (result.units_rejected > 0) {
        parts.push(
          `Logged ${result.units_rejected} reject${result.units_rejected === 1 ? "" : "s"}`,
        );
      }
      setNotice(parts.length ? `${parts.join(". ")}.` : null);
      clearFailure(link.id);
      setRejectTarget(null);
      setRejectNote("");
      await reload();
      if (profileId != null) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.buildWorkflow(profileId),
        });
      }
      onVerified?.();
    } catch (e) {
      recordFailure({
        linkId: link.id,
        filename: link.filename,
        action,
        cause: e,
        retry: () => void runVerify(link, decisions, action),
      });
    } finally {
      setBusy(false);
    }
  };

  const onConfirmAll = (link: PrinterCheckoffLink) => {
    const units = pendingUnits(link);
    if (!units.length) return;
    void runVerify(
      link,
      units.map((u) => ({
        part_id: u.part_id,
        unit_index: u.unit_index,
        result: "confirmed" as const,
      })),
      "verification",
    );
  };

  const onSubmitReject = () => {
    if (!rejectTarget) return;
    const link = displayLinks.find((l) => l.id === rejectTarget.linkId);
    if (!link) return;
    const units = pendingUnits(link);
    if (!units.length) return;
    void runVerify(
      link,
      units.map((u) => ({
        part_id: u.part_id,
        unit_index: u.unit_index,
        result: "rejected" as const,
        reason: rejectReason,
        note: rejectNote.trim() || undefined,
      })),
      "rejection",
    );
  };

  const onDismissFailed = async (link: PrinterCheckoffLink) => {
    setBusy(true);
    try {
      await dismissPrinterCheckoff({ link_id: link.id });
      clearFailure(link.id);
      await reload();
      if (profileId != null) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.buildWorkflow(profileId),
        });
      }
    } catch (e) {
      recordFailure({
        linkId: link.id,
        filename: link.filename,
        action: "dismissal",
        cause: e,
        retry: () => void onDismissFailed(link),
      });
    } finally {
      setBusy(false);
    }
  };

  const retryLink = (linkId: string) => retryHandlers.current.get(linkId)?.();

  if (!engineReady || profileId == null) return null;

  const showFailed = displayFailedLinks.length > 0;
  const actionableLinks = displayLinks.filter((l) => !suppressedHosts.has(l.integration_id));
  const suppressedAwaiting = displayLinks.filter((l) => suppressedHosts.has(l.integration_id));
  // Watching links always show proposal + printing (Confirm suppressed until finish).
  const watchingForDisplay = displayWatchingLinks.length > 0 ? displayWatchingLinks : suppressedAwaiting;
  const showWatching = watchingForDisplay.length > 0;
  const showVerify = actionableLinks.length > 0;

  const errorFor = (linkId: string) =>
    getCheckoffRowError(linkErrors, checkoffLinkErrorKey(linkId));

  if (!showFailed && !showVerify && !showWatching && !readError) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-2 print:hidden", className)}>
      {readError ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm",
            statusTone({ tone: "error", emphasis: "surface" }),
          )}
          role="alert"
        >
          <span className="min-w-0 flex-1 text-destructive">{readError}</span>
          <Button size="sm" variant="secondary" className="min-h-9" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {displayFailedLinks.map((link) => (
        <div
          key={link.id}
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            statusTone({ tone: "error", emphasis: "surface" }),
          )}
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
              className="min-h-9"
              disabled={busy}
              onClick={() => void onDismissFailed(link)}
            >
              Dismiss
            </Button>
          </div>
          {errorFor(link.id) ? (
            <CheckoffRowErrorNotice
              className="mt-2"
              error={errorFor(link.id)!}
              busy={busy}
              onRetry={() => retryLink(link.id)}
            />
          ) : null}
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
                className={cn(
                  "rounded-lg px-4 py-4 text-sm shadow-sm",
                  statusTone({ tone: "info", emphasis: "surface" }),
                )}
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
              className={cn(
                "rounded-lg px-4 py-4 text-sm shadow-sm",
                statusTone({ tone: "warning", emphasis: "surface" }),
              )}
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
                    className="min-h-11"
                    disabled={busy || units.length === 0}
                    onClick={() => onConfirmAll(link)}
                  >
                    <Check className="mr-1 h-4 w-4" aria-hidden />
                    Confirm
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-11"
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
                {errorFor(link.id) ? (
                  <CheckoffRowErrorNotice
                    error={errorFor(link.id)!}
                    busy={busy}
                    onRetry={() => retryLink(link.id)}
                  />
                ) : null}
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
            className="mb-2 min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
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
            className="mb-2 min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
            placeholder="Optional note"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            maxLength={500}
          />
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={busy} onClick={onSubmitReject}>
              Save reject
            </Button>
            <Button
              variant="ghost"
              className="min-h-11"
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
