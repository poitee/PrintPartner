import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Printer } from "lucide-react";
import type { PrinterHostStatus } from "@print-partner/contracts";
import {
  fetchIntegrationStatus,
  fetchIntegrations,
  type IntegrationSummary,
} from "../api/endpoints/integrations";
import {
  fetchPrinterCheckoffLinks,
  type PrinterCheckoffLink,
} from "../api/endpoints/checkoff";
import { fetchPrinters, type PrinterMachine } from "../api/endpoints/printers";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import PageShell from "../components/layout/PageShell";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { resolveEngineState } from "../lib/workflowState";
import { useProfileSelection } from "../context/ProfileContext";
import {
  formatPrinterStatusPill,
  printerDeskTypeLabel,
  printerLiveStripTone,
  type LiveStripHostType,
} from "../lib/printerLiveStrip";
import {
  findPlanNameForLiveJob,
  liveJobPlanCaption,
} from "../lib/printerPlanBind";
import { usePrinterStatusPollMs } from "../hooks/usePrinterStatusPollMs";
import { exportRoute, settingsPrintersRoute } from "../lib/routes";
import {
  configuredHost,
  formatTemperature,
  formatUptime,
  toneBadgeVariant,
} from "../lib/printersPageModel";
import { cn } from "@/lib/utils";

const HOST_TYPES = new Set<LiveStripHostType>(["moonraker", "prusalink", "bambu"]);

type LinkedPrinter = {
  printer: PrinterMachine;
  host: IntegrationSummary;
  hostType: LiveStripHostType;
};

export default function PrintersPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { profiles } = useProfileSelection();
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";
  const pollMs = usePrinterStatusPollMs();
  const [linked, setLinked] = useState<LinkedPrinter[]>([]);
  const [statusById, setStatusById] = useState<Record<string, PrinterHostStatus>>({});
  const [checkoffLinks, setCheckoffLinks] = useState<PrinterCheckoffLink[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const requestId = useRef(0);
  const linkedRef = useRef(linked);
  linkedRef.current = linked;

  const planNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of profiles) map.set(p.id, p.name);
    return map;
  }, [profiles]);

  const refreshRoster = useCallback(async () => {
    if (!engineReady) {
      setLinked([]);
      setStatusById({});
      setCheckoffLinks([]);
      setLoadError(null);
      setRosterLoading(false);
      return;
    }
    setRosterLoading(true);
    try {
      const [fleet, integrations, checkoff] = await Promise.all([
        fetchPrinters(),
        fetchIntegrations(),
        fetchPrinterCheckoffLinks()
          .then((r) => r)
          .catch(() => null),
      ]);
      const byId = new Map(integrations.map((i) => [i.id, i]));
      const next: LinkedPrinter[] = [];
      for (const machine of fleet) {
        // Skip disabled fleet rows (plan/machine flag) and disabled hosts.
        if (machine.enabled === false) continue;
        const id = machine.integration_id?.trim();
        if (!id) continue;
        const host = byId.get(id);
        if (!host || host.config.enabled === false) continue;
        if (!HOST_TYPES.has(host.type as LiveStripHostType)) continue;
        next.push({
          printer: machine,
          host,
          hostType: host.type as LiveStripHostType,
        });
      }
      setLinked(next);
      // Keep last successful links on transient failure (avoid flashing "No plan.").
      if (checkoff) setCheckoffLinks(checkoff.links ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setLinked([]);
      setCheckoffLinks([]);
    } finally {
      setRosterLoading(false);
    }
  }, [engineReady]);

  const refreshStatuses = useCallback(async (rows: LinkedPrinter[]) => {
    const id = ++requestId.current;
    if (!rows.length) {
      if (id === requestId.current) {
        setStatusById({});
        setCheckoffLinks([]);
      }
      return;
    }
    const integrationIds = [...new Set(rows.map((r) => r.host.id))];
    const [entries, checkoff] = await Promise.all([
      Promise.all(
        integrationIds.map(async (integrationId) => {
          try {
            return [integrationId, await fetchIntegrationStatus(integrationId)] as const;
          } catch (e) {
            return [
              integrationId,
              {
                state: "offline" as const,
                message: e instanceof Error ? e.message : String(e),
              },
            ] as const;
          }
        }),
      ),
      fetchPrinterCheckoffLinks()
        .then((r) => r)
        .catch(() => null),
    ]);
    if (id !== requestId.current) return;
    setStatusById(Object.fromEntries(entries));
    if (checkoff) setCheckoffLinks(checkoff.links ?? []);
  }, []);

  useEffect(() => {
    void refreshRoster();
  }, [refreshRoster]);

  useEffect(() => {
    if (!engineReady || linked.length === 0) return;

    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void refreshStatuses(linkedRef.current);
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
  }, [engineReady, linked, refreshStatuses, pollMs]);

  return (
    <PageShell width="list">
      <PageHeader
        icon={Printer}
        accent
        eyebrow="Workshop"
        title="Printers"
        description="Live status for linked printers. Add and manage them in Settings."
        actions={
          <PageHeaderActions>
            <Button size="sm" variant="outline" asChild>
              <Link to={settingsPrintersRoute()}>Add printer</Link>
            </Button>
          </PageHeaderActions>
        }
      />

      {loadError && (
        <p className="text-sm text-destructive" role="alert">
          Could not load printers: {loadError}
        </p>
      )}

      {!engineReady ? (
        <p
          className="text-sm text-muted-foreground"
          role={engineState === "loading" ? "status" : undefined}
        >
          {engineState === "offline"
            ? "Engine offline — start the print-partner engine to view printers."
            : "Connecting to the engine…"}
        </p>
      ) : rosterLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading printers…
        </p>
      ) : linked.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No linked printers</CardTitle>
            <CardDescription>
              Add a Klipper, Prusa, or Bambu printer in Settings to see live status here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" asChild>
              <Link to={settingsPrintersRoute()}>Add printer</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {linked.map(({ printer, host, hostType }) => {
            const status = statusById[host.id];
            const tone = printerLiveStripTone(status?.state);
            const filename = status?.filename?.trim();
            const canSend = hostType === "moonraker" || hostType === "prusalink";
            return (
              <li key={printer.id}>
                <Card className="h-full border-border shadow-sm">
                  <CardHeader className="space-y-2 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-[15px] font-semibold leading-snug">
                          {printer.name}
                        </CardTitle>
                        <CardDescription className="text-xs">
                          {printerDeskTypeLabel(hostType)}
                        </CardDescription>
                      </div>
                      <Badge
                        variant={toneBadgeVariant(tone)}
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 font-mono text-2xs font-normal",
                        )}
                      >
                        {formatPrinterStatusPill(status)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    {filename ? (
                      (() => {
                        const planCaption = liveJobPlanCaption(
                          findPlanNameForLiveJob({
                            printerId: printer.id,
                            filename,
                            links: checkoffLinks,
                            planNameById,
                          }),
                        );
                        return (
                          <p
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={`${filename} · ${planCaption}`}
                          >
                            {filename}
                            <span className="font-sans text-muted-foreground/80">
                              {" · "}
                              {planCaption}
                            </span>
                          </p>
                        );
                      })()
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {status?.message?.trim() || "No active job"}
                      </p>
                    )}
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border/70 bg-muted/25 p-3 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Nozzle</dt>
                        <dd className="mt-0.5 font-mono">{formatTemperature(status?.nozzle_temperature_c, status?.nozzle_target_c)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Bed</dt>
                        <dd className="mt-0.5 font-mono">{formatTemperature(status?.bed_temperature_c, status?.bed_target_c)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Address</dt>
                        <dd className="mt-0.5 truncate font-mono" title={status?.ip_address ?? configuredHost(host)}>
                          {status?.ip_address ?? configuredHost(host) ?? "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Uptime</dt>
                        <dd className="mt-0.5 font-mono">{formatUptime(status?.uptime_seconds)}</dd>
                      </div>
                    </dl>
                    {status?.progress != null ? (
                      <div className="space-y-1" aria-label={`Print progress ${status.progress}%`}>
                        <div className="flex justify-between text-2xs text-muted-foreground">
                          <span>Progress</span><span className="font-mono">{status.progress}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${status.progress}%` }} />
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {canSend ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={exportRoute()}>Send from Production</Link>
                        </Button>
                      ) : (
                        <p className="text-2xs leading-relaxed text-muted-foreground">
                          Use Bambu Connect from Production.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
