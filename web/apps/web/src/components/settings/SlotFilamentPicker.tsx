/**
 * Compact catalog picker for a printer's loaded-filament slot.
 * Stores filament_color_id (for assigner matching) plus a display label.
 */
import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import type { CatalogColor, FilamentCatalog } from "../../api/engine";
import { allCatalogColors, catalogColorGroups } from "../FilamentSwatch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";

type Props = {
  slot: number;
  extraLabel?: string;
  filamentColorId: string | null;
  catalog: FilamentCatalog | null;
  disabled?: boolean;
  onChange: (colorId: string | null, label: string) => void;
};

function colorLabel(c: CatalogColor): string {
  return (c.combo_label || c.display_name).trim();
}

export default function SlotFilamentPicker({
  slot,
  extraLabel,
  filamentColorId,
  catalog,
  disabled,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => catalogColorGroups(catalog), [catalog]);
  const selected = useMemo(
    () => allCatalogColors(catalog).find((c) => c.id === filamentColorId) ?? null,
    [catalog, filamentColorId],
  );
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        colors: g.colors.filter((c) => {
          const hay = `${colorLabel(c)} ${c.id}`.toLowerCase();
          return hay.includes(q);
        }),
      }))
      .filter((g) => g.colors.length > 0);
  }, [groups, q]);

  const triggerLabel = selected
    ? colorLabel(selected)
    : filamentColorId
      ? filamentColorId
      : "Empty";

  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs text-muted-foreground">
        Slot {slot} loaded filament
        {extraLabel ? ` · ${extraLabel}` : ""}
      </p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-8 w-full justify-start gap-2 px-2 text-left text-xs font-normal"
          >
            <span
              className="inline-block h-3.5 w-3.5 shrink-0 rounded border border-border"
              style={selected?.hex ? { backgroundColor: selected.hex } : undefined}
              aria-hidden
            />
            <span className="min-w-0 truncate">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <div className="relative mb-2">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filament catalog…"
              className="h-8 pl-8 text-xs"
              aria-label={`Search filament for slot ${slot}`}
            />
          </div>
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {catalog ? `No colors match “${query}”.` : "Catalog unavailable."}
              </p>
            ) : (
              filtered.map((group) => (
                <div key={group.label}>
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                  <div className="space-y-0.5">
                    {group.colors.map((c) => {
                      const active = filamentColorId === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          title={colorLabel(c)}
                          onClick={() => {
                            onChange(c.id, colorLabel(c));
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent",
                            active && "bg-accent",
                          )}
                        >
                          <span
                            className="inline-block h-4 w-4 shrink-0 rounded border border-border"
                            style={{ backgroundColor: c.hex }}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate">{colorLabel(c)}</span>
                          {active ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 flex justify-between border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!filamentColorId}
              onClick={() => {
                onChange(null, "");
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
