import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AcceptedPlateSetupUnit,
  AcceptedPlateWorkspace,
  InitializeAcceptedPlatesRequest,
  ProductionGroupingField,
  ProductionGroupingRule,
  ProductionPrinterAssignment,
} from "@print-partner/contracts";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

type AssignmentWorkspace = Extract<AcceptedPlateWorkspace, { kind: "setup" | "ready" }>;
const EMPTY_RULES: readonly ProductionGroupingRule[] = [];
const EMPTY_ASSIGNMENTS: readonly ProductionPrinterAssignment[] = [];
const PART_PAGE_SIZE = 50;

type AssignmentGroupField = "source_layer" | "role" | "source_directory" | "filament_color_id";
type AssignmentFilter = "needs_printer" | "assigned" | "all";
export type PrinterAssignmentDraft = Readonly<{ token: string; printer_id: string | null }>;

function isAssignmentGroupField(value: string): value is AssignmentGroupField {
  return value === "source_layer" || value === "role" ||
    value === "source_directory" || value === "filament_color_id";
}

function isAssignmentFilter(value: string): value is AssignmentFilter {
  return value === "needs_printer" || value === "assigned" || value === "all";
}

type Props = Readonly<{
  workspace: AssignmentWorkspace;
  rules?: readonly ProductionGroupingRule[];
  savedAssignments?: readonly ProductionPrinterAssignment[];
  submitting: boolean;
  selectedTokens?: ReadonlySet<string>;
  onSubmit: (request: InitializeAcceptedPlatesRequest) => Promise<void>;
  onAssignmentsChange?: (assignments: readonly PrinterAssignmentDraft[]) => void;
  onCancel?: () => void;
}>;

function unitRuleValue(
  unit: AcceptedPlateSetupUnit,
  field: ProductionGroupingField | AssignmentGroupField,
): string | null {
  if (field === "color" || field === "filament_color_id") {
    return unit.filament_color_id?.trim() || unit.filament_hex?.trim() || unit.filament_custom_hex?.trim() || null;
  }
  if (field === "source_directory") return unit.source_directory;
  if (field === "source_layer") return unit.source_layer;
  if (field === "role") return unit.role;
  if (field === "part") return unit.object_name;
  return null;
}

function suggestedPrinter(
  unit: AcceptedPlateSetupUnit,
  rules: readonly ProductionGroupingRule[],
): string | null {
  const rule = rules.find((candidate) =>
    candidate.enabled && candidate.kind === "assign_to_printer" &&
    unitRuleValue(unit, candidate.field) === candidate.value
  );
  return rule?.kind === "assign_to_printer" ? rule.printer_id : null;
}

function assignmentRows(workspace: AssignmentWorkspace) {
  const currentPrinterIds = new Set(workspace.printers.map((printer) => printer.id));
  if (workspace.kind === "setup") {
    return workspace.units.map((unit) => {
      const printerId: string | null = null;
      return { unit, printerId };
    });
  }
  const placed = workspace.plates.flatMap((plate) => plate.units.map((unit) => ({
    unit,
    printerId: currentPrinterIds.has(plate.printer.id) ? plate.printer.id : null,
  })));
  const unplaced = workspace.unplaced.map((unit) => ({
    unit,
    printerId: currentPrinterIds.has(unit.printer_id) ? unit.printer_id : null,
  }));
  const unassigned = workspace.unassigned.map((unit) => {
    const printerId: string | null = null;
    return { unit, printerId };
  });
  return [...placed, ...unplaced, ...unassigned];
}

export default function AcceptedPlateAssignmentForm({
  workspace,
  rules = EMPTY_RULES,
  savedAssignments = EMPTY_ASSIGNMENTS,
  submitting,
  selectedTokens,
  onSubmit,
  onAssignmentsChange,
  onCancel,
}: Props) {
  const assignmentsEdited = useRef(false);
  const rows = useMemo(() => {
    const all = assignmentRows(workspace);
    if (selectedTokens == null) return all;
    return all.filter((row) => selectedTokens.has(row.unit.token));
  }, [selectedTokens, workspace]);
  const savedAssignmentByToken = useMemo(
    () => new Map(savedAssignments.map((assignment) => [assignment.token, assignment.printer_id])),
    [savedAssignments],
  );
  const [assignments, setAssignments] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(rows.map((row) => [
      row.unit.token,
      row.printerId ?? savedAssignmentByToken.get(row.unit.token) ?? suggestedPrinter(row.unit, rules),
    ])),
  );
  const [groupField, setGroupField] = useState<AssignmentGroupField>("source_layer");
  const [filter, setFilter] = useState<AssignmentFilter>(() => rows.length > 30 ? "needs_printer" : "all");
  const [search, setSearch] = useState("");
  const [showParts, setShowParts] = useState(rows.length <= 30);
  const [visibleLimit, setVisibleLimit] = useState(PART_PAGE_SIZE);
  useEffect(() => {
    if (assignmentsEdited.current) return;
    setAssignments((current) => Object.fromEntries(rows.map((row) => [
      row.unit.token,
      current[row.unit.token] ?? savedAssignmentByToken.get(row.unit.token) ?? suggestedPrinter(row.unit, rules),
    ])));
  }, [rows, rules, savedAssignmentByToken]);
  const complete = rows.length > 0 && rows.every((row) => {
    const printerId = assignments[row.unit.token];
    return printerId != null && workspace.printers.some((printer) => printer.id === printerId);
  });
  const assignedCount = rows.filter((row) => assignments[row.unit.token] != null).length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredRows = rows.filter((row) => {
    const printerId = assignments[row.unit.token];
    if (filter === "needs_printer" && printerId != null) return false;
    if (filter === "assigned" && printerId == null) return false;
    if (!normalizedSearch) return true;
    return [
      row.unit.object_name,
      row.unit.filename,
      row.unit.source_layer,
      row.unit.source_directory,
      row.unit.role,
      row.unit.filament_color_id ?? "",
      row.unit.filament_hex ?? "",
      row.unit.filament_custom_hex ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
  });
  const groupValues: Readonly<Record<AssignmentGroupField, readonly string[]>> = {
    source_layer: [...new Set(filteredRows.map((row) => unitRuleValue(row.unit, "source_layer")).filter((value): value is string => value !== null))],
    source_directory: [...new Set(filteredRows.map((row) => unitRuleValue(row.unit, "source_directory")).filter((value): value is string => value !== null && value !== ""))],
    filament_color_id: [...new Set(filteredRows.map((row) => unitRuleValue(row.unit, "filament_color_id")).filter((value): value is string => value !== null))],
    role: [...new Set(filteredRows.map((row) => unitRuleValue(row.unit, "role")).filter((value): value is string => value !== null))],
  };

  const submit = async () => {
    if (!complete) return;
    await onSubmit({
      expected: workspace.basis,
      expected_plate_revision_id: workspace.kind === "ready"
        ? workspace.plate_revision_id
        : workspace.expected_plate_revision_id,
      assignments: rows.map((row) => ({
        token: row.unit.token,
        printer_id: assignments[row.unit.token] ?? null,
      })),
    });
  };

  const fillGroup = (
    field: AssignmentGroupField,
    value: string,
    printerId: string | null,
  ) => {
    assignmentsEdited.current = true;
    const next = Object.fromEntries(rows.map((row) => [
      row.unit.token,
      unitRuleValue(row.unit, field) === value ? printerId : assignments[row.unit.token] ?? null,
    ]));
    setAssignments(next);
    onAssignmentsChange?.(rows.map((row) => ({
      token: row.unit.token,
      printer_id: next[row.unit.token] ?? null,
    })));
  };

  const groupAssignment = (field: AssignmentGroupField, value: string) => {
    const matching = filteredRows.filter((row) => unitRuleValue(row.unit, field) === value);
    const assigned = new Set(matching.map((row) => assignments[row.unit.token] ?? ""));
    return {
      value: assigned.size === 1 ? [...assigned][0] ?? "" : "",
      mixed: assigned.size > 1,
    };
  };

  const groupSelect = (
    field: AssignmentGroupField,
    value: string,
    label: string,
  ) => {
    const current = groupAssignment(field, value);
    const ariaLabel = field === "source_layer"
      ? `Assign ${value || "Unlabelled"} Source layer`
      : field === "source_directory"
        ? `Assign ${value}`
        : field === "filament_color_id"
          ? `Assign ${value} color`
          : `Assign ${value || "Unlabelled"} role`;
    return (
    <label key={`${field}:${value}`} className="grid gap-1 text-xs font-medium">
      {label}
      <select
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        value={current.value}
        aria-label={ariaLabel}
        disabled={submitting}
        onChange={(event) => fillGroup(field, value, event.target.value || null)}
      >
        <option value="">{current.mixed ? "Mixed assignments" : "Unassigned"}</option>
        {workspace.printers.map((printer) => (
          <option key={printer.id} value={printer.id}>{printer.name} · {printer.model}</option>
        ))}
      </select>
    </label>
    );
  };

  return (
    <div className="space-y-4">
      {workspace.kind === "ready" ? (
        <p className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
          Rearranging replaces all manual Plate positions.
        </p>
      ) : null}
      {workspace.printers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No eligible Printers are configured.</p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_12rem_auto] sm:items-end">
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setVisibleLimit(PART_PAGE_SIZE);
          }}
          placeholder="Search part, layer, directory, color, or role"
          aria-label="Search Plate assignments"
        />
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          value={filter}
          aria-label="Filter Plate assignments"
          onChange={(event) => {
            if (isAssignmentFilter(event.target.value)) setFilter(event.target.value);
            setVisibleLimit(PART_PAGE_SIZE);
          }}
        >
          <option value="needs_printer">Needs printer</option>
          <option value="assigned">Assigned</option>
          <option value="all">All parts</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Showing {filteredRows.length} of {rows.length} parts
        </p>
      </div>
      {workspace.printers.length > 0 ? (
        <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="grid gap-1 text-xs font-medium">
              Assign groups by
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={groupField}
                onChange={(event) => {
                  if (isAssignmentGroupField(event.target.value)) setGroupField(event.target.value);
                }}
              >
                <option value="source_layer">Source layer</option>
                {groupValues.source_directory.length > 0 || groupField === "source_directory"
                  ? <option value="source_directory">Source directory</option>
                  : null}
                {groupValues.filament_color_id.length > 0 || groupField === "filament_color_id"
                  ? <option value="filament_color_id">Color</option>
                  : null}
                <option value="role">Role</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {assignedCount} of {rows.length} parts assigned
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {groupValues[groupField].map((value) => groupSelect(
              groupField,
              value,
              `${value || "Unlabelled"} · ${filteredRows.filter((row) => unitRuleValue(row.unit, groupField) === value).length} parts`,
            ))}
          </div>
        </div>
      ) : null}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setShowParts((current) => !current)}>
            {showParts ? "Hide individual parts" : `Review individual parts (${rows.length})`}
          </Button>
          {!complete ? <span className="text-xs text-amber-700 dark:text-amber-300">{rows.length - assignedCount} still need a printer</span> : null}
        </div>
        {showParts ? (
          <>
            <div className="divide-y divide-border rounded-md border border-border">
        {filteredRows.slice(0, visibleLimit).map(({ unit }) => (
          <div key={unit.token} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{unit.object_name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {unit.source_layer} · {unit.role}{unit.source_directory ? ` · ${unit.source_directory}` : ""}
              </p>
            </div>
            <label className="grid gap-1 text-xs font-medium">
              Printer
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={assignments[unit.token] ?? ""}
                disabled={submitting}
                onChange={(event) => {
                  assignmentsEdited.current = true;
                  const next = {
                    ...assignments,
                    [unit.token]: event.target.value || null,
                  };
                  setAssignments(next);
                  onAssignmentsChange?.(rows.map((row) => ({
                    token: row.unit.token,
                    printer_id: next[row.unit.token] ?? null,
                  })));
                }}
              >
                <option value="">Unassigned</option>
                {workspace.printers.map((printer) => (
                  <option key={printer.id} value={printer.id}>
                    {printer.name} · {printer.model}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
              {filteredRows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No parts match this view.</p>
              ) : null}
            </div>
            {filteredRows.length > visibleLimit ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setVisibleLimit((current) => current + PART_PAGE_SIZE)}>
                Show {Math.min(PART_PAGE_SIZE, filteredRows.length - visibleLimit)} more
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={!complete || submitting} loading={submitting}>
          {workspace.kind === "ready" ? "Rearrange Plates" : "Arrange Plates"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
        ) : null}
      </div>
    </div>
  );
}
