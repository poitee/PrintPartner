import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createPlanSnapshotApi,
  restorePlanSnapshotApi,
} from "../../api/engine";
import { invalidatePlanStructure } from "../../queries/planLayers";
import {
  invalidatePlanRecipe,
  usePlanRecipeQuery,
} from "../../queries/planRecipe";
import { invalidateSources } from "../../queries/sources";
import { Button } from "../ui/button";

type Props = {
  profileId: number;
};

/** Timeline of decisions + build recipe + snapshots for the active plan. */
export default function BuildRecipePanel({ profileId }: Props) {
  const queryClient = useQueryClient();
  const recipeQuery = usePlanRecipeQuery(profileId);
  const recipe = recipeQuery.data?.recipe ?? null;
  const decisions = recipeQuery.data?.decisions ?? [];
  const snapshots = recipeQuery.data?.snapshots ?? [];
  const loading = recipeQuery.isFetching;
  const loadError = recipeQuery.error
    ? recipeQuery.error instanceof Error
      ? recipeQuery.error.message
      : String(recipeQuery.error)
    : null;
  const [busy, setBusy] = useState(false);

  const copyRecipe = async () => {
    if (!recipe?.markdown) return;
    try {
      await navigator.clipboard.writeText(recipe.markdown);
      toast.success("Recipe copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  const onCreateSnapshot = async () => {
    setBusy(true);
    try {
      await createPlanSnapshotApi(profileId, { name: `Manual ${new Date().toISOString().slice(0, 16)}` });
      toast.success("Snapshot saved");
      await invalidatePlanRecipe(queryClient, profileId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Snapshot failed");
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (sid: number, name: string) => {
    if (!window.confirm(`Restore snapshot “${name}”? This replaces layers and kit selections.`)) {
      return;
    }
    setBusy(true);
    try {
      const result = await restorePlanSnapshotApi(profileId, sid);
      toast.success(
        result.needs_sync
          ? "Restored. Sync sources whose refs changed, then rebuild the Plan."
          : "Snapshot restored",
      );
      await Promise.all([
        invalidatePlanStructure(queryClient, profileId),
        invalidateSources(queryClient),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  const recent = decisions.slice(-16).reverse();

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">Recipe / Decisions</h2>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={loading || !recipe} onClick={() => void copyRecipe()}>
            Copy recipe
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => void onCreateSnapshot()}>
            Save snapshot
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void recipeQuery.refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}

      {loading && !recipe ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {recipe && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Base:</span>{" "}
                {recipe.base.source_name
                  ? `${recipe.base.source_name}${recipe.base.tag ? ` @ ${recipe.base.tag}` : ""}`
                  : "(none)"}
              </p>
              <p>
                <span className="font-medium text-foreground">Addons:</span>{" "}
                {recipe.addons.length
                  ? recipe.addons.map((a) => a.source_name).join(", ")
                  : "(none)"}
              </p>
              {recipe.stack_preset && (
                <p>
                  <span className="font-medium text-foreground">Preset:</span> {recipe.stack_preset}
                </p>
              )}
            </div>
          )}

          <div>
            <h3 className="mb-1 text-xs font-medium text-foreground">Decision trail</h3>
            {recent.length === 0 ? (
              <p className="text-xs text-muted-foreground">No decisions logged yet.</p>
            ) : (
              <ol className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
                {recent.map((d) => (
                  <li key={d.id} className="border-l-2 border-border pl-2">
                    <span className="text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()} · {d.kind}
                    </span>
                    <div className="text-foreground">{d.label || d.action_type || "note"}</div>
                    {d.summary ? (
                      <div className="text-muted-foreground">{d.summary.slice(0, 160)}</div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-foreground">Snapshots</h3>
            {snapshots.length === 0 ? (
              <p className="text-xs text-muted-foreground">No snapshots yet.</p>
            ) : (
              <ul className="max-h-36 space-y-1 overflow-y-auto text-xs">
                {[...snapshots].reverse().map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {s.name}{" "}
                      <span className="text-muted-foreground">
                        ({new Date(s.created_at).toLocaleString()})
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() => void onRestore(s.id, s.name)}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
