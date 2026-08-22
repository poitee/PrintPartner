import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_QUANTITY_REGEX,
  DEFAULT_STL_NAMING_PROFILE,
  fetchStlNaming,
  previewStlNaming,
  saveStlNaming,
  type StlNamingFolderRule,
  type StlNamingProfile,
  type StlNamingRole,
  type StlNamingRoleId,
} from "../../api/engine";
import { DataTable } from "../DataTable";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { invalidateProfiles } from "../../queries/profiles";
import { queryClient } from "../../queries/queryClient";

const ROLE_LABELS: Record<StlNamingRoleId, string> = {
  primary: "Primary",
  accent: "Accent",
  clear: "Clear",
  opaque: "Opaque",
};

function markersToInput(markers: string[]): string {
  return markers.join(", ");
}

function parseMarkersInput(value: string): string[] {
  return value
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function isEngineNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("404");
}

type EditorBodyProps = {
  profile: StlNamingProfile;
  onChange: (profile: StlNamingProfile) => void;
  previewProfile: StlNamingProfile;
  compact?: boolean;
  disabled?: boolean;
};

function StlNamingEditorBody({
  profile,
  onChange,
  previewProfile,
  compact = false,
  disabled = false,
}: EditorBodyProps) {
  const [examplePath, setExamplePath] = useState("parts/[a]_frame_x4.stl");
  const [preview, setPreview] = useState<{ role: string; quantity: number; part_slug: string } | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const updateRoleMarkers = (roleId: StlNamingRoleId, markersText: string) => {
    const markers = parseMarkersInput(markersText);
    onChange({
      ...profile,
      roles: profile.roles.map((role) =>
        role.id === roleId ? { ...role, markers } : role,
      ),
    });
  };

  const moveRoleOrder = (index: number, direction: -1 | 1) => {
    const order = [...profile.export_role_order];
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    onChange({ ...profile, export_role_order: order });
  };

  const updateFolderRule = (index: number, patch: Partial<StlNamingFolderRule>) => {
    onChange({
      ...profile,
      folder_rules: profile.folder_rules.map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule,
      ),
    });
  };

  const addFolderRule = () => {
    onChange({
      ...profile,
      folder_rules: [...profile.folder_rules, { path_contains: "", role_id: "accent" }],
    });
  };

  const removeFolderRule = (index: number) => {
    onChange({
      ...profile,
      folder_rules: profile.folder_rules.filter((_, i) => i !== index),
    });
  };

  useEffect(() => {
    const path = examplePath.trim();
    if (!path) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        setPreviewLoading(true);
        setPreviewError(null);
        try {
          const result = await previewStlNaming({
            relative_path: path,
            profile: previewProfile,
          });
          setPreview(result);
        } catch (e) {
          setPreview(null);
          if (isEngineNotFoundError(e)) {
            setPreviewError("Unable to preview naming — this feature isn't available right now.");
          } else {
            setPreviewError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          setPreviewLoading(false);
        }
      })();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [examplePath, previewProfile]);

  const inputClass = compact ? "text-sm" : undefined;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div>
        <h4 className="mb-2 text-sm font-medium">Role markers</h4>
        <p className="mb-2 text-xs text-muted-foreground">
          Substrings in path or filename that assign accent, clear, or opaque. Primary has no
          markers.
        </p>
        <div className="overflow-x-auto rounded-md border border-border">
          <DataTable className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-28">Role</th>
                <th>Markers (comma-separated)</th>
              </tr>
            </thead>
            <tbody>
              {profile.roles.map((role: StlNamingRole) => (
                <tr key={role.id}>
                  <td className="text-muted-foreground">{ROLE_LABELS[role.id] ?? role.label}</td>
                  <td>
                    <Input
                      className={inputClass}
                      value={markersToInput(role.markers)}
                      placeholder={role.id === "primary" ? "(none)" : `[${role.id[0]}]`}
                      disabled={disabled || role.id === "primary"}
                      onChange={(e) => updateRoleMarkers(role.id, e.target.value)}
                      aria-label={`${role.label} markers`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="stl-qty-regex">Quantity pattern (regex)</Label>
        <p className="text-xs text-muted-foreground">
          Must include one capture group for the count, matched against the filename before{" "}
          <code className="text-xs">.stl</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="stl-qty-regex"
            className={`font-mono ${inputClass ?? ""}`}
            value={profile.quantity.regex}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...profile,
                quantity: { ...profile.quantity, regex: e.target.value },
              })
            }
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || profile.quantity.regex === DEFAULT_QUANTITY_REGEX}
            onClick={() =>
              onChange({
                ...profile,
                quantity: { ...profile.quantity, regex: DEFAULT_QUANTITY_REGEX },
              })
            }
          >
            Reset to default
          </Button>
        </div>
      </div>

      {!compact && (
        <>
          <div>
            <h4 className="mb-2 text-sm font-medium">Export role order</h4>
            <p className="mb-2 text-xs text-muted-foreground">
              Order used when grouping parts for STL zip export.
            </p>
            <ul className="space-y-1">
              {profile.export_role_order.map((roleId, index) => (
                <li
                  key={roleId}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
                >
                  <span className="min-w-[5rem] text-muted-foreground">
                    {index + 1}. {ROLE_LABELS[roleId]}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled || index === 0}
                      onClick={() => moveRoleOrder(index, -1)}
                      aria-label={`Move ${ROLE_LABELS[roleId]} up`}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled || index === profile.export_role_order.length - 1}
                      onClick={() => moveRoleOrder(index, 1)}
                      aria-label={`Move ${ROLE_LABELS[roleId]} down`}
                    >
                      ↓
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Folder rules</h4>
              <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={addFolderRule}>
                Add rule
              </Button>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              Optional: assign a role when the relative path contains a substring (checked before
              filename markers).
            </p>
            {profile.folder_rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No folder rules.</p>
            ) : (
              <ul className="space-y-2">
                {profile.folder_rules.map((rule, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-2">
                    <Input
                      className={`min-w-[10rem] flex-1 font-mono text-sm`}
                      placeholder="path contains…"
                      value={rule.path_contains}
                      disabled={disabled}
                      onChange={(e) => updateFolderRule(index, { path_contains: e.target.value })}
                    />
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      value={rule.role_id}
                      disabled={disabled}
                      onChange={(e) =>
                        updateFolderRule(index, { role_id: e.target.value as StlNamingRoleId })
                      }
                    >
                      {(Object.keys(ROLE_LABELS) as StlNamingRoleId[]).map((id) => (
                        <option key={id} value={id}>
                          {ROLE_LABELS[id]}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      value={rule.functional_class ?? ""}
                      disabled={disabled}
                      onChange={(e) =>
                        updateFolderRule(index, {
                          functional_class: (e.target.value || undefined) as
                            | "functional"
                            | "cosmetic"
                            | undefined,
                        })
                      }
                      aria-label="Functional class"
                    >
                      <option value="">Class: none</option>
                      <option value="functional">Functional</option>
                      <option value="cosmetic">Cosmetic</option>
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => removeFolderRule(index)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
        <Label htmlFor="stl-naming-preview-path">Live preview</Label>
        <Input
          id="stl-naming-preview-path"
          className={`font-mono ${inputClass ?? ""}`}
          value={examplePath}
          disabled={disabled}
          onChange={(e) => setExamplePath(e.target.value)}
          placeholder="path/to/part.stl"
        />
        {previewLoading && <p className="text-xs text-muted-foreground">Parsing…</p>}
        {previewError && <p className="text-xs text-destructive">{previewError}</p>}
        {preview && !previewError && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Role</dt>
            <dd>{ROLE_LABELS[preview.role as StlNamingRoleId] ?? preview.role}</dd>
            <dt className="text-muted-foreground">Quantity</dt>
            <dd>{preview.quantity}</dd>
            <dt className="text-muted-foreground">Part slug</dt>
            <dd className="font-mono text-xs">{preview.part_slug}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

type SettingsCardProps = {
  engineReady: boolean;
};

export function StlNamingSettingsCard({ engineReady }: SettingsCardProps) {
  const [saved, setSaved] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [draft, setDraft] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiMissing, setApiMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!engineReady) return;
    setLoading(true);
    setLoadError(null);
    setApiMissing(false);
    try {
      const profile = await fetchStlNaming();
      setSaved(profile);
      setDraft(profile);
    } catch (e) {
      if (isEngineNotFoundError(e)) {
        setApiMissing(true);
        setLoadError("Unable to load naming rules — this feature isn't available right now.");
      } else {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [engineReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = useMemo(
    () => JSON.stringify(saved) !== JSON.stringify(draft),
    [saved, draft],
  );

  const onSave = async () => {
    setSaving(true);
    setLoadError(null);
    try {
      const next = await saveStlNaming(draft);
      setSaved(next);
      setDraft(next);
      await invalidateProfiles(queryClient);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const onRestoreDefaults = () => {
    setDraft(DEFAULT_STL_NAMING_PROFILE);
  };

  return (
    <Card className="shadow-none" id="stl-naming">
      <CardHeader>
        <CardTitle level={3} className="text-base">STL naming rules</CardTitle>
        <CardDescription>
          How the scanner detects part role, quantity, and slug from STL paths. Defaults match
          Voron-style{" "}
          <code className="text-xs">[a]</code>/<code className="text-xs">[c]</code>/
          <code className="text-xs">[o]</code> markers and <code className="text-xs">_x4</code>{" "}
          quantities.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        {!engineReady ? (
          <p className="text-sm text-muted-foreground">Waiting for engine…</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading naming rules…</p>
        ) : (
          <>
            <StlNamingEditorBody
              profile={draft}
              onChange={setDraft}
              previewProfile={draft}
              disabled={apiMissing || saving}
            />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={() => void onSave()} disabled={apiMissing || saving || !dirty}>
                {saving ? "Saving…" : "Save naming rules"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={apiMissing || saving}
                onClick={onRestoreDefaults}
              >
                Restore defaults
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type EmbeddedProps = {
  profile: StlNamingProfile;
  onChange: (profile: StlNamingProfile) => void;
  previewProfile: StlNamingProfile;
  compact?: boolean;
  disabled?: boolean;
};

export function StlNamingEditorEmbedded({
  profile,
  onChange,
  previewProfile,
  compact,
  disabled,
}: EmbeddedProps) {
  return (
    <StlNamingEditorBody
      profile={profile}
      onChange={onChange}
      previewProfile={previewProfile}
      compact={compact}
      disabled={disabled}
    />
  );
}

export default StlNamingSettingsCard;
