import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Files, Printer } from "lucide-react";
import {
  fetchIntegrations,
  type IntegrationSummary,
} from "../api/endpoints/integrations";
import { fetchPrinterCheckoffLinks } from "../api/endpoints/checkoff";
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
import PrinterWorkspaceSheet from "../components/printers/PrinterWorkspaceSheet";
import { usePrinterStatuses } from "../queries/printerStatuses";

const HOST_TYPES = new Set<LiveStripHostType>(["moonraker", "prusalink", "bambu"]);

type PrinterDesk = {
  printer: PrinterMachine;
  host: IntegrationSummary | null;
  hostType: LiveStripHostType | null;
};

export default function PrintersPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { profiles, selectedProfileId } = useProfileSelection();
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";
  const pollMs = usePrinterStatusPollMs();
  const [printers, setPrinters] = useState<PrinterDesk[]>([]);
  const [workspacePrinterId, setWorkspacePrinterId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);

  const statusIntegrationIds = useMemo(
    () => printers.flatMap((row) => row.host ? [row.host.id] : []),
    [printers],
  );
  const { statusByIntegration: statusById, refresh: refreshStatus } = usePrinterStatuses(
    statusIntegrationIds,
    engineReady,
  );
  const checkoffLinksQuery = useQuery({
    queryKey: ["printer-checkoff-links"],
    queryFn: () => fetchPrinterCheckoffLinks(),
    enabled: engineReady,
    staleTime: pollMs,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const checkoffLinks = checkoffLinksQuery.data?.links ?? [];

  const planNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of profiles) map.set(p.id, p.name);
    return map;
  }, [profiles]);

  const refreshRoster = useCallback(async () => {
    if (!engineReady) {
      setPrinters([]);
      setLoadError(null);
      setRosterLoading(false);
      return;
    }
    setRosterLoading(true);
    setLoadError(null);
    try {
      const [fleet, integrations] = await Promise.all([
        fetchPrinters(),
        fetchIntegrations(),
      ]);
      const byId = new Map(integrations.map((i) => [i.id, i]));
      const next: PrinterDesk[] = [];
      for (const machine of fleet) {
        if (machine.enabled === false) continue;
        const id = machine.integration_id?.trim();
        const candidate = id ? byId.get(id) : undefined;
        const host = candidate?.config.enabled !== false &&
          HOST_TYPES.has(candidate?.type as LiveStripHostType)
          ? candidate ?? null
          : null;
        next.push({
          printer: machine,
          host,
          hostType: host ? host.type as LiveStripHostType : null,
        });
      }
      setPrinters(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setRosterLoading(false);
    }
  }, [engineReady]);

  useEffect(() => {
    void refreshRoster();
  }, [refreshRoster]);

  const workspacePrinter = printers.find(
    (row) => row.printer.id === workspacePrinterId,
  ) ?? null;

  return (
    <PageShell width="list">
      <PageHeader
        icon={Printer}
        accent
        eyebrow="Workshop"
        title="Printers"
        description="Live status, files, cameras, and manual tracking for every workshop printer."
        actions={
          <PageHeaderActions>
            <Button asChild>
              <Link to={settingsPrintersRoute()}>Add printer</Link>
            </Button>
          </PageHeaderActions>
        }
      />

      {loadError && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-destructive" role="alert">
          <p>Could not load printers: {loadError}</p>
          <Button size="sm" variant="secondary" onClick={() => void refreshRoster()}>
            Retry
          </Button>
        </div>
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
      ) : rosterLoading && printers.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading printers…
        </p>
      ) : loadError && printers.length === 0 ? null : printers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No printers</CardTitle>
            <CardDescription>
              Add a printer in Settings. A host is optional for manual file tracking.
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
          {printers.map(({ printer, host, hostType }) => {
            const status = host ? statusById[host.id] : undefined;
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
                          {hostType ? printerDeskTypeLabel(hostType) : `${printer.model} · Manual tracking`}
                        </CardDescription>
                      </div>
                      <Badge
                        variant={toneBadgeVariant(tone)}
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 font-mono text-micro font-normal",
                        )}
                      >
                        {host ? formatPrinterStatusPill(status) : "Unmonitored"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    {filename ? (
                      (() => {
                        const planCaption = checkoffLinksQuery.isPending
                          ? null
                          : liveJobPlanCaption(
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
                            title={planCaption ? `${filename} · ${planCaption}` : filename}
                          >
                            {filename}
                            {planCaption ? (
                              <span className="font-sans text-muted-foreground/80">
                                {" · "}
                                {planCaption}
                              </span>
                            ) : null}
                          </p>
                        );
                      })()
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {status?.message?.trim() || (host ? "No active job" : "Provide a print file to track this printer")}
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
                        <dd className="mt-0.5 truncate font-mono" title={status?.ip_address ?? (host ? configuredHost(host) : undefined)}>
                          {status?.ip_address ?? (host ? configuredHost(host) : undefined) ?? "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Uptime</dt>
                        <dd className="mt-0.5 font-mono">{formatUptime(status?.uptime_seconds)}</dd>
                      </div>
                    </dl>
                    {status?.progress != null ? (
                      <div className="space-y-1" aria-label={`Print progress ${status.progress}%`}>
                        <div className="flex justify-between text-micro text-muted-foreground">
                          <span>Progress</span><span className="font-mono">{status.progress}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${status.progress}%` }} />
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="shop"
                        onClick={() => setWorkspacePrinterId(printer.id)}
                      >
                        <Files className="mr-1.5 h-4 w-4" aria-hidden />
                        Files & tracking
                      </Button>
                      {canSend ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={exportRoute()}>Send from Production</Link>
                        </Button>
                      ) : hostType === "bambu" ? (
                        <p className="text-micro leading-relaxed text-muted-foreground">
                          Use Bambu Connect from Production.
                        </p>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {workspacePrinter ? (
        <PrinterWorkspaceSheet
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setWorkspacePrinterId(null);
          }}
          printer={workspacePrinter.printer}
          host={workspacePrinter.host}
          profiles={profiles}
          selectedProfileId={selectedProfileId}
          links={checkoffLinks}
          onChanged={() => {
            if (workspacePrinter.host) void refreshStatus(workspacePrinter.host.id);
            void checkoffLinksQuery.refetch();
          }}
        />
      ) : null}
    </PageShell>
  );
}
