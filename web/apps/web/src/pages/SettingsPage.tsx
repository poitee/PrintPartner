import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  CalendarClock,
  KeyRound,
  RefreshCw,
  Settings,
  SunMoon,
} from "lucide-react";
import {
  createCustomFilament,
  DATE_FORMAT_PRESETS,
  deleteCustomFilament,
  fetchCustomFilaments,
  fetchGitHubPatSettings,
  fetchSourceUpdateCheckSettings,
  saveGitHubPat,
  saveSourceUpdateCheckInterval,
  startCheckSourceUpdates,
  type CustomFilament,
  type DateFormatId,
  type GitHubPatSettings,
} from "../api/engine";
import {
  fetchDiscordNotifySettings,
  saveDiscordNotifySettings,
  testDiscordNotify,
  type DiscordNotifySettings,
} from "../api/engine";
import { validateDiscordWebhookUrl } from "@print-partner/contracts";
import {
  useBuildTrackingSettingsQuery,
  useSaveBuildTrackingSettingsMutation,
} from "../queries/buildTracking";
import { useDateFormat } from "../context/DateFormatContext";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import RouteBreadcrumbs from "../components/layout/RouteBreadcrumbs";
import { StlNamingSettingsCard } from "../components/settings/StlNamingEditor";
import IntegrationsSettingsCard from "../components/settings/IntegrationsSettingsCard";
import PrintersSettingsCard from "../components/settings/PrintersSettingsCard";
import SlicersSettingsCard from "../components/settings/SlicersSettingsCard";
import AboutUpdatesCard from "../components/settings/AboutUpdatesCard";
import AccountPasswordCard from "../components/settings/AccountPasswordCard";
import BackupManagementCard from "../components/settings/BackupManagementCard";
import ApiKeyManagementCard from "../components/settings/ApiKeyManagementCard";
import LoggingManagementCard from "../components/settings/LoggingManagementCard";
import ThemePreferenceControl from "../components/ThemePreferenceControl";
import SourceCategoryManager from "../components/sources/SourceCategoryManager";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import SupportCta from "../components/SupportCta";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useAppUpdateCheck } from "../hooks/useAppUpdateCheck";
import { useJobRunner } from "../hooks/useJobRunner";
import { useAuth } from "../context/AuthContext";
import { Switch } from "../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  canUseRecoveryTools,
  canUseSettingsResource,
  resolveEngineState,
  resolveSettingsResourceDisplay,
} from "../lib/workflowState";

const UPDATE_INTERVAL_OPTIONS = [
  { value: "0", label: "Off (manual only)" },
  { value: "1", label: "Every hour" },
  { value: "6", label: "Every 6 hours" },
  { value: "24", label: "Every 24 hours" },
  { value: "168", label: "Weekly" },
] as const;

type SettingsResource =
  | "filaments"
  | "githubPat"
  | "sourceUpdates"
  | "discord";

type SettingsResourceLoad = {
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

const INITIAL_RESOURCE_LOAD: SettingsResourceLoad = {
  loading: false,
  loaded: false,
  error: null,
};

const INITIAL_SETTINGS_LOADS: Record<SettingsResource, SettingsResourceLoad> = {
  filaments: INITIAL_RESOURCE_LOAD,
  githubPat: INITIAL_RESOURCE_LOAD,
  sourceUpdates: INITIAL_RESOURCE_LOAD,
  discord: INITIAL_RESOURCE_LOAD,
};

function SettingsSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const location = useLocation();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";
  const { user, multiUser } = useAuth();
  const { format: dateFormat, setFormat: setDateFormat } = useDateFormat();
  const { updateCheck, refresh: refreshUpdateCheck } = useAppUpdateCheck(engineReady);
  const [updateCheckRefreshing, setUpdateCheckRefreshing] = useState(false);
  const { busy: updateBusy, message: updateMessage, runJob: runUpdateJob } =
    useJobRunner("check-source-updates");
  const [filaments, setFilaments] = useState<CustomFilament[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newFilamentName, setNewFilamentName] = useState("");
  const [newFilamentHex, setNewFilamentHex] = useState("#c41230");
  const [githubPat, setGithubPat] = useState<GitHubPatSettings | null>(null);
  const [patInput, setPatInput] = useState("");
  const [patMessage, setPatMessage] = useState<string | null>(null);
  const [deleteFilamentId, setDeleteFilamentId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [updateIntervalHours, setUpdateIntervalHours] = useState("24");
  const [updateIntervalSaving, setUpdateIntervalSaving] = useState(false);
  const [discordSettings, setDiscordSettings] = useState<DiscordNotifySettings | null>(null);
  const [discordWebhookInput, setDiscordWebhookInput] = useState("");
  const [discordWebhookError, setDiscordWebhookError] = useState<string | null>(null);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordTestStatus, setDiscordTestStatus] = useState<string | null>(null);
  const [resourceLoads, setResourceLoads] = useState(INITIAL_SETTINGS_LOADS);
  const {
    data: buildTrackingSettings,
    isLoading: buildTrackingLoading,
    error: buildTrackingError,
  } = useBuildTrackingSettingsQuery(engineReady);
  const saveBuildTrackingMutation = useSaveBuildTrackingSettingsMutation();
  const buildTrackingSaving = saveBuildTrackingMutation.isPending;

  const loadResource = useCallback(
    async (resource: SettingsResource, request: () => Promise<void>) => {
      setResourceLoads((loads) => ({
        ...loads,
        [resource]: { ...loads[resource], loading: true, error: null },
      }));
      try {
        await request();
        setResourceLoads((loads) => ({
          ...loads,
          [resource]: { loading: false, loaded: true, error: null },
        }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setResourceLoads((loads) => ({
          ...loads,
          [resource]: { ...loads[resource], loading: false, error: message },
        }));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!engineReady) return;
    setLoadError(null);
    await Promise.all([
      loadResource("filaments", async () => {
        setFilaments(await fetchCustomFilaments());
      }),
      loadResource("githubPat", async () => {
        setGithubPat(await fetchGitHubPatSettings());
      }),
      loadResource("sourceUpdates", async () => {
        const settings = await fetchSourceUpdateCheckSettings();
        setUpdateIntervalHours(String(settings.interval_hours));
      }),
      loadResource("discord", async () => {
        const settings = await fetchDiscordNotifySettings();
        setDiscordSettings(settings);
        setDiscordWebhookInput(settings.webhook_url ?? "");
      }),
    ]);
  }, [
    engineReady,
    loadResource,
    setDiscordSettings,
    setDiscordWebhookInput,
    setFilaments,
    setGithubPat,
    setLoadError,
    setUpdateIntervalHours,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resourceReady = (resource: SettingsResource) =>
    canUseSettingsResource(engineState, {
      loading: resourceLoads[resource].loading,
      error: resourceLoads[resource].error,
      hasData: resourceLoads[resource].loaded,
    });
  const resourceDisplay = (resource: SettingsResource) =>
    resolveSettingsResourceDisplay({
      loading: resourceLoads[resource].loading,
      error: resourceLoads[resource].error,
      hasData: resourceLoads[resource].loaded,
    });
  const filamentsReady = resourceReady("filaments");
  const githubPatReady = resourceReady("githubPat");
  const sourceUpdatesReady = resourceReady("sourceUpdates");
  const discordReady = resourceReady("discord");
  const recoveryToolsReady = canUseRecoveryTools(engineState);
  const filamentsDisplay = resourceDisplay("filaments");
  const githubPatDisplay = resourceDisplay("githubPat");
  const sourceUpdatesDisplay = resourceDisplay("sourceUpdates");
  const discordDisplay = resourceDisplay("discord");

  // Scroll to hash targets (e.g. /settings#printers) after layout.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "").trim();
    if (!hash) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname]);

  const onAddFilament = async () => {
    if (!newFilamentName.trim()) return;
    try {
      await createCustomFilament({
        display_name: newFilamentName.trim(),
        hex: newFilamentHex,
      });
      setNewFilamentName("");
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteFilament = async (id: string) => {
    setDeleting(true);
    setLoadError(null);
    try {
      await deleteCustomFilament(id);
      setDeleteFilamentId(null);
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const onSaveGitHubPat = async () => {
    setPatMessage(null);
    try {
      const saved = await saveGitHubPat(patInput);
      setGithubPat(saved);
      setPatInput("");
      setPatMessage(saved.configured ? "GitHub PAT saved." : "GitHub PAT cleared.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUpdateIntervalChange = async (value: string) => {
    setUpdateIntervalHours(value);
    setUpdateIntervalSaving(true);
    setLoadError(null);
    try {
      const saved = await saveSourceUpdateCheckInterval(Number(value));
      setUpdateIntervalHours(String(saved.interval_hours));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateIntervalSaving(false);
    }
  };

  const onCheckSourceUpdatesNow = () => {
    void runUpdateJob(() => startCheckSourceUpdates());
  };

  const onClearGitHubPat = async () => {
    setPatMessage(null);
    try {
      const saved = await saveGitHubPat("");
      setGithubPat(saved);
      setPatInput("");
      setPatMessage("GitHub PAT cleared.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onCheckAppUpdates = async () => {
    setUpdateCheckRefreshing(true);
    try {
      await refreshUpdateCheck(true);
    } finally {
      setUpdateCheckRefreshing(false);
    }
  };

  const inputClass =
    "rounded-md border border-input bg-background px-2 py-1.5 text-sm";

  return (
    <div className="space-y-6">
      <RouteBreadcrumbs items={[{ label: "Settings" }]} />
      <PageHeader
        icon={Settings}
        accent
        title="Settings"
        description="Printers, library, appearance, and account."
        actions={
          <PageHeaderActions>
            <SupportCta size="sm" className="min-h-10 w-full sm:w-auto" />
          </PageHeaderActions>
        }
      />

      {engineState !== "ready" && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to change engine settings."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      )}
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {patMessage && <p className="text-sm text-muted-foreground">{patMessage}</p>}
      {updateMessage && <p className="text-sm text-muted-foreground">{updateMessage}</p>}

      <AboutUpdatesCard
        updateCheck={updateCheck}
        onRefresh={onCheckAppUpdates}
        refreshing={updateCheckRefreshing}
      />

      <SettingsSection id="printers" title="Printers">
        <PrintersSettingsCard engineReady={engineReady} />
      </SettingsSection>

      <SettingsSection id="slicers" title="Slicers">
        <SlicersSettingsCard engineReady={engineReady} />
      </SettingsSection>

      <SettingsSection title="Library">
        <div id="source-categories">
          <SourceCategoryManager engineReady={engineReady} />
        </div>

        <StlNamingSettingsCard engineReady={engineReady} />

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle level={3} className="text-base">Custom filaments</CardTitle>
            <CardDescription>
              Named colors appear in the filament picker when assigning parts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {filamentsDisplay === "loading" ? (
              <p className="text-sm text-muted-foreground">Loading custom filaments…</p>
            ) : filamentsDisplay === "initial-error" ? (
              <div className="space-y-2 text-sm text-destructive" role="alert">
                <p>Could not load custom filaments: {resourceLoads.filaments.error}</p>
                <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                  Retry
                </Button>
              </div>
            ) : filaments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No custom filaments yet.</p>
            ) : (
              <ul className="filament-list space-y-2">
                {filaments.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <span
                      className="swatch inline-block h-5 w-5 rounded border border-border"
                      style={{ backgroundColor: f.hex }}
                      title={f.hex}
                    />
                    <span className="text-sm">
                      {f.display_name}{" "}
                      <span className="text-muted-foreground">({f.hex})</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={!filamentsReady}
                      onClick={() => setDeleteFilamentId(f.id)}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={inputClass}
                placeholder="Name"
                disabled={!filamentsReady}
                value={newFilamentName}
                onChange={(e) => setNewFilamentName(e.target.value)}
              />
              <input
                type="color"
                disabled={!filamentsReady}
                value={newFilamentHex}
                onChange={(e) => setNewFilamentHex(e.target.value)}
                title="Color"
              />
              <input
                className={`hex-input ${inputClass}`}
                disabled={!filamentsReady}
                value={newFilamentHex}
                onChange={(e) => setNewFilamentHex(e.target.value)}
              />
              <Button
                disabled={!filamentsReady}
                onClick={() => void onAddFilament()}
              >
                Add filament
              </Button>
            </div>
            {filamentsDisplay === "background-error" && (
              <p className="text-sm text-destructive" role="alert">
                Could not refresh custom filaments: {resourceLoads.filaments.error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader accent>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
                <RefreshCw className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <CardTitle level={3} className="text-base">Source update checks</CardTitle>
                <CardDescription>
                  Compare synced Git repos to their remotes without pulling. Badges appear on
                  Sources when updates are available.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {(sourceUpdatesDisplay === "loading" ||
              sourceUpdatesDisplay === "initial-error") && (
              <p
                className={
                  sourceUpdatesDisplay === "initial-error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                role={sourceUpdatesDisplay === "initial-error" ? "alert" : undefined}
              >
                {sourceUpdatesDisplay === "initial-error"
                  ? `Could not load source update settings: ${resourceLoads.sourceUpdates.error}`
                  : "Loading source update settings…"}
              </p>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Check interval</span>
              <Select
                value={updateIntervalHours}
                onValueChange={(v) => void onUpdateIntervalChange(v)}
                disabled={!sourceUpdatesReady || updateIntervalSaving || updateBusy}
              >
                <SelectTrigger className="min-h-10 w-full max-w-none sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPDATE_INTERVAL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button
              variant="secondary"
              className="min-h-10 w-full sm:w-auto"
              onClick={onCheckSourceUpdatesNow}
              disabled={!sourceUpdatesReady || updateBusy || updateIntervalSaving}
            >
              {updateBusy ? "Checking…" : "Check now"}
            </Button>
            {sourceUpdatesDisplay === "background-error" && (
              <p className="text-sm text-destructive" role="alert">
                Could not refresh source update settings: {resourceLoads.sourceUpdates.error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader accent>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-brand/10 text-accent-brand">
                <KeyRound className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <CardTitle level={3} className="text-base">GitHub personal access token</CardTitle>
                <CardDescription>
                  Optional. Improves GitHub API rate limits when syncing private repos. Token is stored
                  locally in the engine database.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {githubPatDisplay === "loading" ||
            githubPatDisplay === "initial-error" ? (
              <p
                className={
                  githubPatDisplay === "initial-error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                role={githubPatDisplay === "initial-error" ? "alert" : undefined}
              >
                {githubPatDisplay === "initial-error"
                  ? `Could not load token status: ${resourceLoads.githubPat.error}`
                  : "Loading token status…"}
              </p>
            ) : githubPat?.configured && githubPat.masked ? (
              <p className="text-sm text-muted-foreground">
                Configured: <code className="font-mono text-xs">{githubPat.masked}</code>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No GitHub PAT configured.</p>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Token</span>
              <input
                type="password"
                className={`${inputClass} w-full max-w-md`}
                autoComplete="off"
                disabled={!githubPatReady}
                placeholder={githubPat?.configured ? "Enter new token to replace" : "ghp_…"}
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!githubPatReady}
                onClick={() => void onSaveGitHubPat()}
              >
                Save token
              </Button>
              <Button
                variant="secondary"
                onClick={() => void onClearGitHubPat()}
                disabled={!githubPatReady || !githubPat?.configured}
              >
                Clear token
              </Button>
            </div>
            {githubPatDisplay === "background-error" && (
              <p className="text-sm text-destructive" role="alert">
                Could not refresh token status: {resourceLoads.githubPat.error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader accent>
            <CardTitle level={3} className="text-base">Discord notifications</CardTitle>
            <CardDescription>
              Get notified in Discord when repos update — like Sonarr/Radarr.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(discordDisplay === "loading" || discordDisplay === "initial-error") && (
              <p
                className={
                  discordDisplay === "initial-error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                role={discordDisplay === "initial-error" ? "alert" : undefined}
              >
                {discordDisplay === "initial-error"
                  ? `Could not load Discord settings: ${resourceLoads.discord.error}`
                  : "Loading Discord settings…"}
              </p>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Webhook URL</span>
              <input
                type="text"
                className={`${inputClass} w-full max-w-md`}
                placeholder="https://discord.com/api/webhooks/..."
                autoComplete="off"
                disabled={!discordReady || discordSaving}
                value={discordWebhookInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setDiscordWebhookInput(value);
                  const trimmed = value.trim();
                  setDiscordWebhookError(trimmed.length > 0 ? validateDiscordWebhookUrl(trimmed) : null);
                }}
                aria-invalid={discordWebhookError ? true : undefined}
              />
              {discordWebhookError && (
                <p className="mt-1 text-sm text-destructive">{discordWebhookError}</p>
              )}
            </label>
            <Button
              disabled={
                !discordReady ||
                discordSaving ||
                Boolean(discordWebhookError)
              }
              onClick={async () => {
                const trimmed = discordWebhookInput.trim();
                const error = trimmed.length > 0 ? validateDiscordWebhookUrl(trimmed) : null;
                setDiscordWebhookError(error);
                if (error) return;
                setDiscordSaving(true);
                setDiscordTestStatus(null);
                try {
                  const saved = await saveDiscordNotifySettings({ webhook_url: trimmed || null });
                  setDiscordSettings(saved);
                } catch (e) {
                  setLoadError(e instanceof Error ? e.message : String(e));
                } finally {
                  setDiscordSaving(false);
                }
              }}
            >
              {discordSaving ? "Saving…" : "Save"}
            </Button>
            {discordSettings?.webhook_url && (
              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!discordReady || discordSaving}
                    checked={discordSettings.notify_on_update}
                    onChange={async (e) => {
                      try {
                        const saved = await saveDiscordNotifySettings({ notify_on_update: e.target.checked });
                        setDiscordSettings(saved);
                      } catch (e) {
                        setLoadError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  />
                  Notify when a source is auto-synced (updates)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!discordReady || discordSaving}
                    checked={discordSettings.auto_sync_updates}
                    onChange={async (e) => {
                      try {
                        const saved = await saveDiscordNotifySettings({ auto_sync_updates: e.target.checked });
                        setDiscordSettings(saved);
                      } catch (e) {
                        setLoadError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  />
                  Auto-sync sources when updates are detected
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!discordReady || discordSaving}
                    checked={discordSettings.notify_on_sync}
                    onChange={async (e) => {
                      try {
                        const saved = await saveDiscordNotifySettings({ notify_on_sync: e.target.checked });
                        setDiscordSettings(saved);
                      } catch (e) {
                        setLoadError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  />
                  Notify on manual syncs
                </label>
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    variant="secondary"
                    disabled={!discordReady || discordSaving}
                    onClick={async () => {
                      setDiscordTestStatus(null);
                      try {
                        const result = await testDiscordNotify();
                        setDiscordTestStatus(result.ok ? "✅ Test message sent!" : `❌ ${result.error ?? "Failed"}`);
                      } catch (e) {
                        setDiscordTestStatus(`❌ ${e instanceof Error ? e.message : String(e)}`);
                      }
                    }}
                  >
                    Send test message
                  </Button>
                  {discordTestStatus && (
                    <span className="text-sm text-muted-foreground">{discordTestStatus}</span>
                  )}
                </div>
              </div>
            )}
            {discordDisplay === "background-error" && (
              <p className="text-sm text-destructive" role="alert">
                Could not refresh Discord settings: {resourceLoads.discord.error}
              </p>
            )}
          </CardContent>
        </Card>

        <IntegrationsSettingsCard engineReady={engineReady} />
      </SettingsSection>

      <SettingsSection id="build-tracking" title="Build Tracking">
        <Card>
          <CardHeader accent>
            <CardTitle level={3} className="text-base">Assembly tracking</CardTitle>
            <CardDescription>
              Adds an Assembled toggle to each completed part - useful for multi-week builds where
              you want to track which printed parts have been physically installed. Tracks
              printed-but-not-yet-installed state for complex builds like Voron.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!buildTrackingSettings && (
              <p
                className={
                  buildTrackingError
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                role={buildTrackingError ? "alert" : undefined}
              >
                {buildTrackingError
                  ? `Could not load assembly tracking settings: ${
                      buildTrackingError instanceof Error
                        ? buildTrackingError.message
                        : String(buildTrackingError)
                    }`
                  : "Loading assembly tracking settings…"}
              </p>
            )}
            <label className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
              <span className="text-sm font-medium">Enable assembly tracking</span>
              <Switch
                checked={buildTrackingSettings?.assembly_tracking ?? false}
                disabled={
                  !engineReady ||
                  buildTrackingLoading ||
                  !buildTrackingSettings ||
                  buildTrackingSaving
                }
                onCheckedChange={(checked) => {
                  saveBuildTrackingMutation.mutate(
                    { assembly_tracking: checked },
                    {
                      onError: (e) =>
                        setLoadError(e instanceof Error ? e.message : String(e)),
                    },
                  );
                }}
                aria-label="Enable assembly tracking"
              />
            </label>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection title="Appearance">
        <Card>
          <CardHeader accent>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-brand/10 text-accent-brand">
                <SunMoon className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <CardTitle level={3} className="text-base">Appearance</CardTitle>
                <CardDescription>
                  Choose light, dark, or match your system preference. In-app Export and
                  print dialogs follow the theme. Paper checkoff sheets stay light when
                  printing.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ThemePreferenceControl />
          </CardContent>
        </Card>

        <Card>
          <CardHeader accent>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
                <CalendarClock className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <CardTitle level={3} className="text-base">Date &amp; time format</CardTitle>
                <CardDescription>
                  Controls how timestamps like &quot;Last synced&quot; and printed-checklist &quot;Generated&quot;
                  lines are displayed everywhere in the app.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Format</span>
              <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as DateFormatId)}>
                <SelectTrigger className="min-h-10 w-full max-w-none sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FORMAT_PRESETS.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </CardContent>
        </Card>
      </SettingsSection>

      {multiUser && user?.provider === "email" ? (
        <SettingsSection title="Account">
          <AccountPasswordCard />
        </SettingsSection>
      ) : null}

      {recoveryToolsReady && (
        <SettingsSection id="data" title="Data & System">
          <BackupManagementCard />
          <ApiKeyManagementCard />
          <LoggingManagementCard />
        </SettingsSection>
      )}

      <Dialog
        open={deleteFilamentId != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteFilamentId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove custom filament?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteFilamentId
              ? `Remove “${filaments.find((f) => f.id === deleteFilamentId)?.display_name ?? "this filament"}” from your custom colors?`
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={deleting}
              onClick={() => setDeleteFilamentId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              disabled={
                !filamentsReady ||
                deleting ||
                deleteFilamentId == null
              }
              onClick={() => deleteFilamentId && void onDeleteFilament(deleteFilamentId)}
            >
              {deleting ? "Removing…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
