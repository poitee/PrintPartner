import type { RequiredUnitToken } from "@print-partner/contracts";
import type { ProductionSelectableUnit } from "../../lib/productionSelection";
import { Button } from "../ui/button";

type Props = Readonly<{
  units: readonly ProductionSelectableUnit[];
  selection: ReadonlySet<RequiredUnitToken>;
  onToggle: (token: RequiredUnitToken) => void;
  onClearGroup: (field: "source_layer" | "role", value: string) => void;
  onSelectAll: () => void;
  onSelectIncomplete: () => void;
  onClearAll: () => void;
}>;

export default function ProductionSelectionPanel({
  units,
  selection,
  onToggle,
  onClearGroup,
  onSelectAll,
  onSelectIncomplete,
  onClearAll,
}: Props) {
  const sourceLayers = [...new Set(units.map((unit) => unit.source_layer))];
  const selectedCount = units.filter((unit) => selection.has(unit.token)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Required units
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground">
          {selectedCount} selected
        </p>
      </div>
      {sourceLayers.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {sourceLayers.map((sourceLayer) => (
            <Button
              key={sourceLayer}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onClearGroup("source_layer", sourceLayer)}
            >
              Clear {sourceLayer || "Unlabelled"}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onSelectIncomplete}>Select incomplete</Button>
        <Button type="button" size="sm" variant="outline" onClick={onSelectAll}>Select all</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClearAll}>Clear all</Button>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {units.map((unit) => (
          <label
            key={unit.token}
            className="flex cursor-pointer items-start gap-3 p-3"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={selection.has(unit.token)}
              aria-label={unit.object_name}
              onChange={() => onToggle(unit.token)}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{unit.object_name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {unit.source_layer} · {unit.role}
                {unit.source_directory ? ` · ${unit.source_directory}` : ""}
                {unit.completed ? " · complete" : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
