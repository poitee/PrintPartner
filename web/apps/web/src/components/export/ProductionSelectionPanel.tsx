import { useState } from "react";
import type { RequiredUnitToken } from "@print-partner/contracts";
import type { ProductionSelectableUnit } from "../../lib/productionSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type SelectionFilter = "selected" | "not_selected" | "all";
const UNIT_PAGE_SIZE = 50;

function isSelectionFilter(value: string): value is SelectionFilter {
  return value === "selected" || value === "not_selected" || value === "all";
}

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
  const [showUnits, setShowUnits] = useState(units.length <= 30);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SelectionFilter>(() => units.length > 30 ? "selected" : "all");
  const [visibleLimit, setVisibleLimit] = useState(UNIT_PAGE_SIZE);
  const sourceLayers = [...new Set(units.map((unit) => unit.source_layer))];
  const selectedCount = units.filter((unit) => selection.has(unit.token)).length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleUnits = units.filter((unit) => {
    const selected = selection.has(unit.token);
    if (filter === "selected" && !selected) return false;
    if (filter === "not_selected" && selected) return false;
    if (!normalizedSearch) return true;
    return [unit.object_name, unit.source_layer, unit.source_directory, unit.role]
      .some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Required units in this work package
        </h2>
        <p className="font-mono text-2xs text-muted-foreground">
          {selectedCount} of {units.length} selected
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
              aria-label={`Clear ${sourceLayer || "Unlabelled"}`}
              onClick={() => onClearGroup("source_layer", sourceLayer)}
            >
              Clear {sourceLayer || "Unlabelled"} ({units.filter((unit) =>
                unit.source_layer === sourceLayer && selection.has(unit.token)
              ).length}/{units.filter((unit) => unit.source_layer === sourceLayer).length})
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onSelectIncomplete}>Use incomplete units</Button>
        <Button type="button" size="sm" variant="outline" onClick={onSelectAll}>Use all units</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClearAll}>Clear selection</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setShowUnits((current) => !current)}>
          {showUnits ? "Hide individual selection" : `Edit individual selection (${units.length})`}
        </Button>
      </div>
      {showUnits ? (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_12rem]">
            <Input
              type="search"
              value={search}
              aria-label="Search production parts"
              placeholder="Search part, layer, directory, or role"
              onChange={(event) => {
                setSearch(event.target.value);
                setVisibleLimit(UNIT_PAGE_SIZE);
              }}
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={filter}
              aria-label="Filter production parts"
              onChange={(event) => {
                if (isSelectionFilter(event.target.value)) setFilter(event.target.value);
                setVisibleLimit(UNIT_PAGE_SIZE);
              }}
            >
              <option value="selected">Selected</option>
              <option value="not_selected">Not selected</option>
              <option value="all">All parts</option>
            </select>
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
        {visibleUnits.slice(0, visibleLimit).map((unit) => (
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
            {visibleUnits.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No parts match this view.</p>
            ) : null}
          </div>
          {visibleUnits.length > visibleLimit ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setVisibleLimit((current) => current + UNIT_PAGE_SIZE)}>
              Show {Math.min(UNIT_PAGE_SIZE, visibleUnits.length - visibleLimit)} more
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
