import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import {
  fetchIntegrationStatus,
  fetchIntegrations,
  fetchPrinters,
  reconcilePrinterCheckoff,
  type PrinterHostStatus,
} from "../../api/engine";
import { settingsPrintersRoute } from "../../lib/routes";
import {
  formatPrinterHostCaption,
  formatPrinterJobLine,
  formatPrinterStatusPill,
  printerLiveStripTone,
  type LiveStripHostType,
} from "../../lib/printerLiveStrip";
import { quietPrinterLoadError, quietPrinterStatusMessage } from "../../lib/printerErrorCopy";
import { usePrinterStatusPollMs } from "../../hooks/usePrinterStatusPollMs";
import { cn } from "../../lib/utils";

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

function toneClass(tone: ReturnType<typeof printerLiveStripTone>): string {
  switch (tone) {
    case "idle":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
    case "printing":
      return "border-sky-500/35 bg-sky-500/10 text-sky-950 dark:text-sky-100";
    case "paused":
      return "border-amber-500/35 bg-amber-500/10 text-amber-950 dark:text-amber-100";
    case "complete":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "offline":
      return "border-border bg-muted/60 text-muted-foreground";
    default:
      return "border-border bg-card text-muted-foreground";
  }
}

function pillClass(tone: ReturnType<typeof printerLiveStripTone>): string {
  switch (tone) {
    case "printing":
      return "border-sky-500/40 bg-sky-500/20 text-sky-950 dark:text-sky-50";
    case "paused":
      return "border-amber-500/40 bg-amber-500/20 text-amber-950 dark:text-amber-50";
    case "complete":
    case "idle":
      return "border-emerald-500/40 bg-emerald-500/20 text-emerald-950 dark:text-emerald-50";
    case "error":
      return "border-destructive/40 bg-destructive/15 text-destructive";
    default:
      return "border-border bg-background/70 text-muted-foreground";
  }
}

/**
 * Sticky Progress banner: live status for fleet machines linked to a printer host.
 * Moonraker/PrusaLink: reconcile may queue verify after finish (no Progress mutation).
 * Bambu: status poll only.
 * CoS lock: never auto-tick Progress units from printing/complete host status —
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
  const [statusById, setStatusById] = useState<Record<string, PrinterHostStatus>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const toastedLinks = useRef(new Set<string>());
  const onCheckoffUpdateRef = useRef(onCheckoffUpdate);
  onCheckoffUpdateRef.current = onCheckoffUpdate;
  const onLiveStateChangeRef = useRef(onLiveStateChange);
  onLiveStateChangeRef.current = onLiveStateChange;
  const onUnattributedUpdateRef = useRef(onUnattributedUpdate);
  onUnattributedUpdateRef.current = onUnattributedUpdate;
  const pollMs = usePrinterStatusPollMs();

  const refreshRoster = useCallback(async () => {
    if (!engineReady) {
      setHosts([]);
      setStatusById({});
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

  const refreshStatuses = useCallback(async (linked: LinkedHost[]) => {
    const id = ++requestId.current;
    if (!linked.length) {
      if (id === requestId.current) setStatusById({});
      return;
    }
    // Prune status map to only currently linked printers, keeping existing values so
    // nothing flashes offline while we wait for slow reconcile responses.
    // Do NOT clear to {} first — that's what causes the offline flash.
    if (id === requestId.current) {
      const linkedIds = new Set(linked.map((h) => h.integrationId));
      setStatusById((prev) => {
        const next: Record<string, PrinterHostStatus> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (linkedIds.has(k)) next[k] = v;
        }
        return next;
      });
    }
    let receivedReconcileResult = false;
    await Promise.allSettled(
      linked.map(async (h) => {
        try {
          let status: PrinterHostStatus;
          if (!h.reconcileCheckoff) {
            status = await fetchIntegrationStatus(h.integrationId);
          } else {
            const reconcileResult = await reconcilePrinterCheckoff({
              integration_id: h.integrationId,
            });
            const { updates, created_links: createdLinks, status: s } = reconcileResult;
            status = s;
            for (const row of updates ?? []) {
              if (toastedLinks.current.has(row.link_id)) continue;
              toastedLinks.current.add(row.link_id);
              if (row.event === "awaiting_verify") {
                toast.success("Print finished — see highlighted parts");
              } else {
                toast.error(
                  `${row.host_name} ${row.host_outcome === "cancelled" ? "cancelled" : "failed"} ${row.filename} — review send`,
                );
              }
              onCheckoffUpdateRef.current?.(row.profile_id);
            }
            for (const link of createdLinks ?? []) {
              onCheckoffUpdateRef.current?.(link.profile_id);
            }
            // A per-host result is only a hint to refresh the authoritative global list.
            const unattributed = (reconcileResult as Record<string, unknown>).unattributed;
            if (Array.isArray(unattributed)) {
              receivedReconcileResult = true;
            }
          }
          if (id === requestId.current) {
            setStatusById((prev) => ({ ...prev, [h.integrationId]: status }));
          }
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          if (id === requestId.current) {
            setStatusById((prev) => ({
              ...prev,
              [h.integrationId]: {
                state: "offline" as const,
                message: quietPrinterStatusMessage(raw) ?? "Unavailable",
              },
            }));
          }
        }
      }),
    );
    if (id === requestId.current && receivedReconcileResult) {
      onUnattributedUpdateRef.current?.();
    }
  }, []);

  useEffect(() => {
    void refreshRoster();
  }, [refreshRoster]);

  useEffect(() => {
    if (!engineReady || hosts.length === 0) return;

    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void refreshStatuses(hostsRef.current);
    };

    tick();
    const timer = window.setInterval(tick, pollMs);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      requestId.current += 1;
    };
  }, [engineReady, hosts, refreshStatuses, pollMs]);

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
          "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm print:hidden",
          quiet
            ? "border-border bg-muted/50 text-muted-foreground"
            : "border-destructive/30 bg-destructive/5",
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
              "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-sm",
              toneClass(tone),
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
                "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums",
                pillClass(tone),
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
