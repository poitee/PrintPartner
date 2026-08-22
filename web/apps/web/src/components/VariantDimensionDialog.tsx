import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  applyPlanVariantSelection,
  fetchPlanVariantDimensions,
  type PlanVariantDimensionsResponse,
} from "../api/engine";

type Props = {
  profileId: number;
  /** Called once the user confirms their selection (or skips). */
  onDone: () => void;
};

/**
 * Shown after plan creation when the base source manifest declares variant_dimensions.
 * Lets the user pick one value per dimension (e.g. size=300) before the first sync.
 * Skipping leaves import rules untouched.
 */
export default function VariantDimensionDialog({ profileId, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PlanVariantDimensionsResponse | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchPlanVariantDimensions(profileId);
        if (cancelled) return;
        if (Object.keys(res.dimensions ?? {}).length === 0) {
          // No variant dimensions — skip silently
          onDone();
          return;
        }
        setData(res);
        // Pre-populate with existing selection
        setPending({ ...res.selection });
        setOpen(true);
      } catch {
        // Not fatal — just skip variant configuration
        if (!cancelled) onDone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, onDone]);

  const allPicked =
    data != null &&
    Object.keys(data.dimensions).every((dim) => Boolean(pending[dim]));

  const onConfirm = async () => {
    if (!data?.source_id) return;
    setSaving(true);
    setError(null);
    try {
      await applyPlanVariantSelection(profileId, pending, data.source_id);
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onSkip = () => {
    setOpen(false);
    onDone();
  };

  if (!data) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onSkip(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure build variant</DialogTitle>
          <p className="text-sm text-muted-foreground">
            This project supports multiple size or configuration options. Pick
            one value per dimension so only the matching files are imported.
          </p>
        </DialogHeader>

        <div className="space-y-4">
          {Object.entries(data.dimensions).map(([dim, values]) => (
            <div key={dim} className="space-y-2">
              <p className="text-sm font-medium capitalize">{dim.replace(/_/g, " ")}</p>
              <div className="flex flex-wrap gap-2">
                {values.map((val) => {
                  const strVal = String(val);
                  const active = pending[dim] === strVal;
                  return (
                    <button
                      key={strVal}
                      type="button"
                      disabled={saving}
                      aria-pressed={active}
                      className={[
                        "min-h-10 rounded-md border px-3 py-2 text-sm transition-colors sm:min-h-0 sm:py-1.5",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      ].join(" ")}
                      onClick={() =>
                        setPending((prev) => ({ ...prev, [dim]: strVal }))
                      }
                    >
                      {strVal}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onSkip} disabled={saving}>
            Skip
          </Button>
          <Button
            disabled={!allPicked || saving}
            onClick={() => void onConfirm()}
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
