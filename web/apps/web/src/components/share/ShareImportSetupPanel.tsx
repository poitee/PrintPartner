import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { buildRoute, sourcesRoute } from "../../lib/routes";
import {
  addProfileAddonLayer,
  createSource,
  saveImportRules,
  setProfileBaseLayer,
  startSync,
} from "../../api/engine";

export type UnmatchedSource = {
  name: string;
  url: string;
  branch: string;
  /** Git tag pin when the shared source was tag-pinned (not branch tip). */
  tag?: string | null;
  source_kind: string;
  role: string;
  import_rules: string[];
  manifest_community_slug?: string | null;
  layer_type?: string;
};

type Props = {
  unmatchedSources: UnmatchedSource[];
  warnings: string[];
  profileId: number | null;
  onDismiss?: () => void;
  /** Called after a source is created/attached so the page can refresh. */
  onSourcesChanged?: () => void;
};

type AddState = "idle" | "adding" | "added" | "error";

function sourceKey(s: UnmatchedSource): string {
  return `${s.url}::${s.name}`;
}

/** A shared source can be re-added automatically only if it has a remote URL. */
function isAddable(s: UnmatchedSource): boolean {
  return Boolean(s.url) && s.source_kind !== "archive" && s.source_kind !== "local";
}

export default function ShareImportSetupPanel({
  unmatchedSources,
  warnings,
  profileId,
  onDismiss,
  onSourcesChanged,
}: Props) {
  const [states, setStates] = useState<Record<string, AddState>>({});

  if (unmatchedSources.length === 0 && warnings.length === 0) return null;

  const addSource = async (s: UnmatchedSource) => {
    if (!isAddable(s)) return;
    const key = sourceKey(s);
    setStates((prev) => ({ ...prev, [key]: "adding" }));
    try {
      const tag = s.tag?.trim() || null;
      const created = await createSource({
        name: s.name || s.url,
        url: s.url,
        branch: s.branch || "main",
        tag,
        source_kind: s.source_kind || "github",
        category: s.role && s.role !== "unassigned" ? s.role : null,
      });
      if (s.import_rules.length > 0) {
        await saveImportRules(created.id, s.import_rules);
      }
      if (profileId != null) {
        if (s.layer_type === "base") {
          await setProfileBaseLayer(profileId, created.id);
        } else {
          await addProfileAddonLayer(profileId, created.id);
        }
      }
      await startSync([created.id]);
      setStates((prev) => ({ ...prev, [key]: "added" }));
      onSourcesChanged?.();
      toast.success(`Added “${created.name}” — syncing now`);
    } catch (e) {
      setStates((prev) => ({ ...prev, [key]: "error" }));
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const addableSources = unmatchedSources.filter(isAddable);
  const pendingAddable = addableSources.filter((s) => states[sourceKey(s)] !== "added");

  const addAll = async () => {
    // Sequential so layer ordering stays deterministic.
    for (const s of pendingAddable) {
      await addSource(s);
    }
  };

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
      <h2 className="text-sm font-semibold">Share import setup</h2>
      {unmatchedSources.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            This shared build references repos you don&apos;t have yet. Add them to fetch the
            STLs, then <strong>Rebuild plan</strong> and check Parts.
          </p>
          {pendingAddable.length > 0 && (
            <Button size="sm" className="mb-2" onClick={() => void addAll()}>
              Add &amp; sync all ({pendingAddable.length})
            </Button>
          )}
          <ul className="space-y-2 text-sm">
            {unmatchedSources.map((s) => {
              const key = sourceKey(s);
              const state = states[key] ?? "idle";
              const addable = isAddable(s);
              return (
                <li key={key} className="rounded-md border border-border bg-card p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{s.name || s.url}</p>
                      {s.url && (
                        <p className="text-xs text-muted-foreground truncate">{s.url}</p>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {s.layer_type === "base" ? "Base" : "Add-on"}
                        {s.tag?.trim()
                          ? ` · tag ${s.tag.trim()}`
                          : s.branch
                            ? ` · ${s.branch}`
                            : ""}
                        {s.source_kind ? ` · ${s.source_kind}` : ""}
                      </p>
                      {s.import_rules.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Suggested import: {s.import_rules.join(", ")}
                        </p>
                      )}
                      {s.manifest_community_slug && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Community manifest: {s.manifest_community_slug}
                        </p>
                      )}
                    </div>
                    {addable ? (
                      <Button
                        size="sm"
                        variant={state === "added" ? "ghost" : "secondary"}
                        disabled={state === "adding" || state === "added"}
                        onClick={() => void addSource(s)}
                      >
                        {state === "adding"
                          ? "Adding…"
                          : state === "added"
                            ? "Added ✓"
                            : state === "error"
                              ? "Retry"
                              : "Add & sync"}
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Local files — re-add manually
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" asChild>
            <Link to={sourcesRoute()}>Manage on Sources</Link>
          </Button>
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {profileId != null && (
          <Button size="sm" asChild>
            <Link to={buildRoute(profileId)}>Open Build</Link>
          </Button>
        )}
        {onDismiss && (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </section>
  );
}
