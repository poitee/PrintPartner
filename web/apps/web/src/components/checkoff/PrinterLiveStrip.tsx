import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { fetchIntegrations } from "../../api/endpoints/integrations";
import { fetchPrinters } from "../../api/endpoints/printers";
import { reconcilePrinterCheckoff } from "../../api/endpoints/checkoff";
import { settingsPrintersRoute } from "../../lib/routes";
import {
  formatPrinterHostCaption,
  formatPrinterJobLine,
  formatPrinterStatusPill,
  printerLiveStripTone,
  printerStatusTone,
  type LiveStripHostType,
} from "../../lib/printerLiveStrip";
import { statusTone } from "../../lib/statusTone";
import { quietPrinterLoadError, quietPrinterStatusMessage } from "../../lib/printerErrorCopy";
import { usePrinterStatusPollMs } from "../../hooks/usePrinterStatusPollMs";
import { cn } from "@/lib/utils";
import { usePrinterStatuses } from "../../queries/printerStatuses";

const LIVE_STRIP_HOST_TYPES = new Set<LiveStripHostType>([
  "moonraker",
  "prusalink",
  "bambu",
]);

type LinkedHost = {
  integrationId: string;
  name: string;
  hostType: LiveStripHostType;
  /** Moonraker/PrusaLink run verify reconcile; Bambu is status-only. */
  reconcileCheckoff: boolean;
};

export type PrinterLiveStripState = {
  anyPrinting: boolean;
  /** Integration ids currently printing or paused (for per-link verify suppress). */
  activeIntegrationIds: string[];
  /** Integration ids currently idle or complete (for queue suggestion matching). */
  idleIntegrationIds: string[];
  hostCount: number;
};

type Props = {
  engineReady: boolean;
  /** Called when host finish enters verify queue (or host failed) for a plan. */
  onCheckoffUpdate?: (profileId: number) => void;
  /** Reports whether any linked host is actively printing/paused. */
  onLiveStateChange?: (state: PrinterLiveStripState) => void;
  /** Requests an authoritative global unattributed-print refresh after reconcile. */
  onUnattributedUpdate?: () => void;
  className?: string;
};

type ReconcileResult = Awaited<ReturnType<typeof reconcilePrinterCheckoff>>;

type ReconcileOutcome =
  | Readonly<{
      kind: "success";
      integrationId: string;
      result: ReconcileResult;
    }>
  | Readonly<{
      kind: "failure";
      integrationId: string;
      status: PrinterHostStatus;
    }>;

async function reconcileHost(integrationId: string): Promise<ReconcileOutcome> {
  try {
    const result = await reconcilePrinterCheckoff({ integration_id: integrationId });
    return { kind: "success", integrationId, result };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      kind: "failure",
      integrationId,
      status: {
        state: "offline",
        message: quietPrinterStatusMessage(rawMessage) ?? "Unavailable",
      },
    };
  }
}

function printerCheckoffReconciliationKey(
  integrationId: string,
): readonly ["printer-checkoff-reconcile", string] {
  return ["printer-checkoff-reconcile", integrationId];
}

/**
 * Sticky Progress banner: live status for fleet machines linked to a printer host.
 * Moonraker/PrusaLink: reconcile may queue verify after finish (no Progress mutation).
 * Bambu: status poll only.
 * Never auto-tick Progress units from printing/complete host status:
 * units stay operator-ticked; Confirm in verify is the only automated path.
 */
export default function PrinterLiveStrip({
  engineReady,
  onCheckoffUpdate,
  onLiveStateChange,
  onUnattributedUpdate,
  className,
}: Props) {
  const [hosts, setHosts] = useState<LinkedHost[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toastedLinks = useRef(new Set<string>());
  const handledReconciliations = useRef(new WeakSet<ReconcileOutcome>());
  const onCheckoffUpdateRef = useRef(onCheckoffUpdate);
  onCheckoffUpdateRef.current = onCheckoffUpdate;
  const onLiveStateChangeRef = useRef(onLiveStateChange);
  onLiveStateChangeRef.current = onLiveStateChange;
  const onUnattributedUpdateRef = useRef(onUnattributedUpdate);
  onUnattributedUpdateRef.current = onUnattributedUpdate;
  const pollMs = usePrinterStatusPollMs();

  const directStatusIntegrationIds = useMemo(
    () => hosts
      .filter((host) => !host.reconcileCheckoff)
      .map((host) => host.integrationId),
    [hosts],
  );
  const { statusByIntegration: directStatuses } = usePrinterStatuses(
    directStatusIntegrationIds,
    engineReady,
  );
  const reconcileIntegrationIds = useMemo(
    () => hosts
      .filter((host) => host.reconcileCheckoff)
      .map((host) => host.integrationId),
    [hosts],
  );
  const reconciliation = useQueries({
    queries: reconcileIntegrationIds.map((integrationId) => ({
      queryKey: printerCheckoffReconciliationKey(integrationId),
      queryFn: () => reconcileHost(integrationId),
      enabled: engineReady,
      staleTime: pollMs,
      refetchInterval: pollMs,
      refetchIntervalInBackground: false,
      retry: false,
      gcTime: 0,
    })),
    combine: (results) => {
      const outcomes: ReconcileOutcome[] = [];
      const statuses: Record<string, PrinterHostStatus> = {};
      for (const result of results) {
        if (!result.data) continue;
        outcomes.push(result.data);
        statuses[result.data.integrationId] = result.data.kind === "success"
          ? result.data.result.status
          : result.data.status;
      }
      return {
        outcomes,
        statuses,
      };
    },
  });
  const statusById = useMemo(
    () => ({ ...directStatuses, ...reconciliation.statuses }),
    [directStatuses, reconciliation.statuses],
  );

  const refreshRoster = useCallback(async () => {
    if (!engineReady) {
      setHosts([]);
      setLoadError(null);
      return;
    }
    try {
      const [fleet, integrations] = await Promise.all([
        fetchPrinters(),
        fetchIntegrations(),
      ]);
      const byId = new Map(integrations.map((i) => [i.id, i]));
      const seen = new Set<string>();
      const next: LinkedHost[] = [];
      for (const machine of fleet) {
        const id = machine.integration_id?.trim();
        if (!id || seen.has(id)) continue;
        const host = byId.get(id);
        if (!host || host.config.enabled === false) continue;
        if (!LIVE_STRIP_HOST_TYPES.has(host.type as LiveStripHostType)) continue;
        const hostType = host.type as LiveStripHostType;
        seen.add(id);
        next.push({
          integrationId: id,
          name: host.name.trim() || machine.name.trim() || "Printer",
          hostType,
          reconcileCheckoff: hostType === "moonraker" || hostType === "prusalink",
        });
      }
      setHosts(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setHosts([]);
    }
  }, [engineReady]);

  useEffect(() => {
    void refreshRoster();
  }, [refreshRoster]);

  useEffect(() => {
    let receivedReconcileResult = false;
    for (const outcome of reconciliation.outcomes) {
      if (handledReconciliations.current.has(outcome)) continue;
      handledReconciliations.current.add(outcome);
      if (outcome.kind === "failure") continue;
      const { result } = outcome;
      for (const row of result.updates ?? []) {
        if (toastedLinks.current.has(row.link_id)) continue;
        toastedLinks.current.add(row.link_id);
        if (row.event === "awaiting_verify") {
          toast.success("Print finished. See highlighted parts.");
        } else {
          toast.error(
            `${row.host_name} ${row.host_outcome === "cancelled" ? "cancelled" : "failed"} ${row.filename}. Review the send.`,
          );
        }
        onCheckoffUpdateRef.current?.(row.profile_id);
      }
      for (const link of result.created_links ?? []) {
        onCheckoffUpdateRef.current?.(link.profile_id);
      }
      if ("unattributed" in result && Array.isArray(result.unattributed)) {
        receivedReconcileResult = true;
      }
    }
    if (receivedReconcileResult) onUnattributedUpdateRef.current?.();
  }, [reconciliation]);

  useEffect(() => {
    const activeIntegrationIds = hosts
      .filter((h) => {
        const state = statusById[h.integrationId]?.state;
        return state === "printing" || state === "paused";
      })
      .map((h) => h.integrationId);
    const idleIntegrationIds = hosts
      .filter((h) => {
        const state = statusById[h.integrationId]?.state;
        return state === "idle" || state === "complete";
      })
      .map((h) => h.integrationId);
    onLiveStateChangeRef.current?.({
      anyPrinting: activeIntegrationIds.length > 0,
      activeIntegrationIds,
      idleIntegrationIds,
      hostCount: hosts.length,
    });
  }, [statusById, hosts]);

  useEffect(() => {
    if (engineReady) return;
    onLiveStateChangeRef.current?.({
      anyPrinting: false,
      activeIntegrationIds: [],
      idleIntegrationIds: [],
      hostCount: 0,
    });
  }, [engineReady]);

  if (!engineReady) return null;

  if (loadError) {
    const { quiet, text } = quietPrinterLoadError(loadError);
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm print:hidden",
          quiet
            ? statusTone({ tone: "neutral", emphasis: "soft" })
            : statusTone({ tone: "error", emphasis: "surface" }),
          className,
        )}
        role="status"
      >
        <Printer
          className={cn("h-4 w-4 shrink-0", quiet ? "opacity-70" : "text-destructive")}
          aria-hidden
        />
        <span className={cn("min-w-0 flex-1", !quiet && "text-destructive")}>
          {quiet ? text : `Could not load printer status: ${text}`}
        </span>
        <Link
          to={settingsPrintersRoute()}
          className="shrink-0 text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          Settings
        </Link>
      </div>
    );
  }

  if (hosts.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-col gap-1.5 print:hidden", className)}
      role="status"
      aria-live="polite"
      aria-label="Linked printer status"
    >
      {hosts.map((host) => {
        const status = statusById[host.integrationId];
        const tone = printerLiveStripTone(status?.state);
        return (
          <div
            key={host.integrationId}
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2 text-sm",
              statusTone({ tone: printerStatusTone(status?.state), emphasis: "soft" }),
            )}
            title={quietPrinterStatusMessage(status?.message) ?? undefined}
          >
            <Printer className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
            <div className="min-w-0 flex-1 leading-snug">
              <p className="font-medium">
                {formatPrinterHostCaption(host.name, host.hostType)}
              </p>
              <p className="text-xs font-normal opacity-90">
                {formatPrinterJobLine(status)}
              </p>
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 font-mono text-micro font-medium tabular-nums",
                statusTone({ tone: printerStatusTone(status?.state), emphasis: "outline" }),
              )}
            >
              {formatPrinterStatusPill(status)}
            </span>
            {(tone === "offline" || tone === "error") && (
              <Link
                to={settingsPrintersRoute()}
                className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
              >
                Check hosts
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
