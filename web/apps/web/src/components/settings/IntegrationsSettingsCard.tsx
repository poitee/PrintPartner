import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  createIntegration,
  deleteIntegration,
  fetchIntegrations,
  fetchSpoolmanDefaultSettings,
  saveSpoolmanDefaultIntegration,
  testIntegration,
  updateIntegration,
  type IntegrationSummary,
} from "../../api/engine";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Props = {
  engineReady: boolean;
};

const NONE = "__none__";

export default function IntegrationsSettingsCard({ engineReady }: Props) {
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("http://192.168.1.50:7912");

  const spoolmanItems = useMemo(
    () => items.filter((i) => i.type === "spoolman"),
    [items],
  );

  const refresh = useCallback(async () => {
    if (!engineReady) return;
    setLoadError(null);
    try {
      const [integrations, defaults] = await Promise.all([
        fetchIntegrations(),
        fetchSpoolmanDefaultSettings(),
      ]);
      setItems(integrations);
      setDefaultId(defaults.integration_id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [engineReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAddSpoolman = async () => {
    const name = newName.trim();
    const base_url = newUrl.trim();
    if (!name || !base_url) return;
    setBusy(true);
    setMessage(null);
    setLoadError(null);
    try {
      const created = await createIntegration({
        type: "spoolman",
        name,
        config: { base_url, enabled: true },
      });
      setNewName("");
      if (!defaultId) {
        const saved = await saveSpoolmanDefaultIntegration(created.id);
        setDefaultId(saved.integration_id);
        setMessage(
          "Spoolman added and enabled for the Build filament picker. Pick a Spoolman color on Build, then update build.",
        );
      } else {
        setMessage(
          "Spoolman integration added. Select it under Use for filament picker if you want it on Build.",
        );
      }
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (id: string) => {
    setTestingId(id);
    setMessage(null);
    setLoadError(null);
    try {
      const result = await testIntegration(id);
      setMessage(result.ok ? result.message ?? "Connected." : result.message ?? "Test failed.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestingId(null);
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    setLoadError(null);
    try {
      await deleteIntegration(id);
      if (defaultId === id) {
        await saveSpoolmanDefaultIntegration(null);
        setDefaultId(null);
      }
      setMessage("Integration removed.");
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDefaultChange = async (value: string) => {
    const next = value === NONE ? null : value;
    setDefaultId(next);
    setLoadError(null);
    try {
      const saved = await saveSpoolmanDefaultIntegration(next);
      setDefaultId(saved.integration_id);
      setMessage(
        next
          ? "Spoolman integration enabled for the Build filament picker."
          : "Spoolman picker disabled.",
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  };

  const onToggleEnabled = async (item: IntegrationSummary, enabled: boolean) => {
    setBusy(true);
    setLoadError(null);
    try {
      await updateIntegration(item.id, { config: { enabled } });
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded-md border border-input bg-background px-2 py-1.5 text-sm w-full";

  return (
    <details className="group rounded-lg border border-border bg-card shadow-none">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-base font-semibold">Optional integrations</p>
          <p className="text-sm text-muted-foreground">
            Spoolman filament inventory for the Build picker. Printer hosts live in the
            Printer hosts card.
          </p>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        {message && <p className="text-sm text-muted-foreground">{message}</p>}

        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">Add Spoolman</p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Name</span>
            <input
              className={inputClass}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workshop Spoolman"
              disabled={!engineReady || busy}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Base URL (no /api/v1)</span>
            <input
              className={inputClass}
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="http://192.168.1.50:7912"
              disabled={!engineReady || busy}
            />
          </label>
          <Button
            className="min-h-10"
            disabled={!engineReady || busy || !newName.trim() || !newUrl.trim()}
            onClick={() => void onAddSpoolman()}
          >
            Add Spoolman
          </Button>
        </div>

        {spoolmanItems.length > 0 && !defaultId && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Choose an integration under Use for filament picker so Spoolman filaments appear on
            Build. After picking a Spoolman filament, choose a physical spool when multiple are
            in stock; remaining weight appears in Review.
          </p>
        )}

        {spoolmanItems.length > 0 && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Use for filament picker</span>
            <Select
              value={defaultId ?? NONE}
              onValueChange={(v) => void onDefaultChange(v)}
              disabled={!engineReady || busy}
            >
              <SelectTrigger className="min-h-10 w-full max-w-none sm:max-w-md">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {spoolmanItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}

        <ul className="space-y-2">
          {spoolmanItems.map((item) => {
            const baseUrl = String(item.config.base_url ?? item.config.baseUrl ?? "");
            const enabled = item.config.enabled !== false;
            return (
              <li
                key={item.id}
                className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{item.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{baseUrl}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) => void onToggleEnabled(item, e.target.checked)}
                  />
                  Enabled
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!engineReady || testingId === item.id}
                  onClick={() => void onTest(item.id)}
                >
                  {testingId === item.id ? "Testing…" : "Test connection"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onDelete(item.id)}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>

        {!spoolmanItems.length && engineReady && (
          <p className="text-sm text-muted-foreground">No Spoolman integrations configured yet.</p>
        )}
      </div>
    </details>
  );
}
