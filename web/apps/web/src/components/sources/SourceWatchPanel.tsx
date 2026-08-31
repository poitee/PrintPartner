import { useEffect, useMemo, useState } from "react";
import { BellRing, GitBranch, RefreshCw } from "lucide-react";
import {
  fetchSourceUpdateCheckSettings,
  saveSourceMonitoringSettings,
  type SourceActivityEvent,
  type SourceUpdateCheckSettings,
} from "../../api/endpoints/sourceContent";
import { useDateFormat } from "../../context/DateFormatContext";
import { useSourceActivityQuery } from "../../queries/sourceMonitoring";
import SourceUpdateIntervalSelect from "../settings/SourceUpdateIntervalSelect";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

type Props = Readonly<{
  githubSourceCount: number;
  manualTrackedCount: number;
  updateCount: number;
  attachedUpdateCount: number;
  lastCheckedAt: string | null;
  checking: boolean;
  syncing: boolean;
  onCheckNow: () => void;
  onSyncGitHub: () => void;
  onShowUpdates: () => void;
  onImportRepositories: () => void;
}>;

function activityText(event: SourceActivityEvent): string {
  switch (event.kind) {
    case "source.update_available":
      return `${event.source_name} has an update`;
    case "source.updated":
      return `${event.source_name} refreshed automatically`;
    case "source.sync_failed":
      return `${event.source_name} could not refresh`;
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

export default function SourceWatchPanel({
  githubSourceCount,
  manualTrackedCount,
  updateCount,
  attachedUpdateCount,
  lastCheckedAt,
  checking,
  syncing,
  onCheckNow,
  onSyncGitHub,
  onShowUpdates,
  onImportRepositories,
}: Props) {
  const { formatDate } = useDateFormat();
  const activity = useSourceActivityQuery(true);
  const [settings, setSettings] = useState<SourceUpdateCheckSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchSourceUpdateCheckSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setSettingsError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveLastChecked = useMemo(() => {
    const candidates = [lastCheckedAt, settings?.last_checked_at]
      .filter((value): value is string => Boolean(value))
      .map((value) => ({ value, time: Date.parse(value) }))
      .filter((candidate) => !Number.isNaN(candidate.time));
    return candidates.sort((left, right) => right.time - left.time)[0]?.value ?? null;
  }, [lastCheckedAt, settings?.last_checked_at]);

  const saveSettings = async (
    patch: Partial<Pick<SourceUpdateCheckSettings, "interval_hours" | "auto_sync_updates">>,
  ) => {
    setSaving(true);
    setSettingsError(null);
    try {
      setSettings(await saveSourceMonitoringSettings(patch));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-primary/30 shadow-sm" aria-labelledby="source-watch-heading">
      <CardHeader accent className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <BellRing className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle id="source-watch-heading" className="text-base">
                Source monitoring
              </CardTitle>
              <Badge variant={updateCount > 0 ? "warning" : "muted"}>
                {updateCount > 0
                  ? `${updateCount} update${updateCount === 1 ? "" : "s"}`
                  : "Up to date"}
              </Badge>
            </div>
            <CardDescription className="mt-1 max-w-3xl text-sm">
              Keep reusable projects current here. Builds keep their published Plan until you
              review and publish a newer Library revision.
            </CardDescription>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={onCheckNow}
            disabled={checking || syncing || githubSourceCount === 0}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {checking ? "Checking…" : "Check now"}
          </Button>
          <Button
            size="sm"
            onClick={onSyncGitHub}
            disabled={syncing || checking || githubSourceCount === 0}
          >
            {syncing ? "Syncing…" : "Sync GitHub"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <dl className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <dt className="text-xs text-muted-foreground">Automatic coverage</dt>
            <dd className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
              <GitBranch className="h-3.5 w-3.5 text-primary" aria-hidden />
              {githubSourceCount} GitHub {githubSourceCount === 1 ? "repo" : "repos"}
            </dd>
          </div>
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <dt className="text-xs text-muted-foreground">Tracked manual sources</dt>
            <dd className="mt-1 text-sm font-semibold">
              {manualTrackedCount} model {manualTrackedCount === 1 ? "page" : "pages"}
            </dd>
          </div>
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <dt className="text-xs text-muted-foreground">Last update check</dt>
            <dd className="mt-1 text-sm font-semibold">
              {effectiveLastChecked ? formatDate(effectiveLastChecked) : "Not checked yet"}
            </dd>
          </div>
        </dl>

        {updateCount > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/35 bg-warning-soft p-3">
            <p className="min-w-0 flex-1 text-sm text-warning">
              {attachedUpdateCount > 0
                ? `${attachedUpdateCount} update${attachedUpdateCount === 1 ? "" : "s"} affect the active Build.`
                : "Updates are ready to review in the Library."}
            </p>
            <Button size="sm" variant="outline" onClick={onShowUpdates}>
              Show updates
            </Button>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.75fr)]">
          <section className="space-y-2" aria-labelledby="source-watch-automation-heading">
            <h3 id="source-watch-automation-heading" className="text-sm font-semibold">
              Automatic checks
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                Check schedule
                <SourceUpdateIntervalSelect
                  value={String(settings?.interval_hours ?? 24)}
                  disabled={!settings || saving}
                  onChange={(value) => void saveSettings({ interval_hours: Number(value) })}
                />
              </label>
              <label className="flex min-h-11 items-start gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={settings?.auto_sync_updates ?? false}
                  disabled={!settings || saving}
                  onChange={(event) =>
                    void saveSettings({ auto_sync_updates: event.target.checked })
                  }
                />
                <span>
                  <span className="block font-medium">Refresh GitHub sources automatically</span>
                  <span className="block text-xs text-muted-foreground">
                    The app records the refresh and notifies you. Published Build Plans do not
                    change automatically.
                  </span>
                </span>
              </label>
            </div>
            {settingsError ? (
              <p className="text-xs text-destructive" role="alert">
                Could not update monitoring settings: {settingsError}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Printables, MakerWorld, and Thangs model pages stay tracked here, but refreshing
              their files requires a new archive downloaded from the provider.
            </p>
            <Button size="sm" variant="ghost" onClick={onImportRepositories}>
              Import a repository list
            </Button>
          </section>

          <section className="space-y-2" aria-labelledby="source-watch-activity-heading">
            <h3 id="source-watch-activity-heading" className="text-sm font-semibold">
              Recent source alerts
            </h3>
            {activity.data && activity.data.length > 0 ? (
              <ul className="space-y-1.5">
                {activity.data.slice(0, 3).map((event) => (
                  <li
                    key={event.id}
                    className="rounded-md border border-border bg-surface-sunken px-3 py-2"
                  >
                    <p className="text-xs font-medium text-foreground">{activityText(event)}</p>
                    <p className="text-micro text-muted-foreground">{formatDate(event.at)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Source updates and automatic refreshes will appear here and in the app banner.
              </p>
            )}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
