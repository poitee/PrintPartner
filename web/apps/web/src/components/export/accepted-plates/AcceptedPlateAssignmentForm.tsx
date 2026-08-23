import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AcceptedPlateSetupUnit,
  AcceptedPlateWorkspace,
  InitializeAcceptedPlatesRequest,
  ProductionGroupingField,
  ProductionGroupingRule,
} from "@print-partner/contracts";
import { Button } from "../../ui/button";

type AssignmentWorkspace = Extract<AcceptedPlateWorkspace, { kind: "setup" | "ready" }>;
const EMPTY_RULES: readonly ProductionGroupingRule[] = [];

type Props = Readonly<{
  workspace: AssignmentWorkspace;
  rules?: readonly ProductionGroupingRule[];
  submitting: boolean;
  selectedTokens?: ReadonlySet<string>;
  onSubmit: (request: InitializeAcceptedPlatesRequest) => Promise<void>;
  onCancel?: () => void;
}>;

function unitRuleValue(
  unit: AcceptedPlateSetupUnit,
  field: ProductionGroupingField,
): string | null {
  if (field === "color") return unit.filament_color_id;
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
  submitting,
  selectedTokens,
  onSubmit,
  onCancel,
}: Props) {
  const assignmentsEdited = useRef(false);
  const rows = useMemo(() => {
    const all = assignmentRows(workspace);
    if (selectedTokens == null) return all;
    return all.filter((row) => selectedTokens.has(row.unit.token));
  }, [selectedTokens, workspace]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(rows.map((row) => [
      row.unit.token,
      row.printerId ?? suggestedPrinter(row.unit, rules),
    ])),
  );
  const sourceLayers = useMemo(() => [...new Set(rows.map((row) => row.unit.source_layer))], [rows]);
  const roles = useMemo(() => [...new Set(rows.map((row) => row.unit.role))], [rows]);
  const directories = useMemo(() => [...new Set(rows.map((row) => row.unit.source_directory).filter(Boolean))], [rows]);
  const colors = useMemo(() => [...new Set(rows.map((row) => row.unit.filament_color_id).filter((value): value is string => Boolean(value)))], [rows]);
  useEffect(() => {
    if (assignmentsEdited.current) return;
    setAssignments((current) => Object.fromEntries(rows.map((row) => [
      row.unit.token,
      current[row.unit.token] ?? suggestedPrinter(row.unit, rules),
    ])));
  }, [rows, rules]);
  const complete = rows.length > 0 && rows.every((row) => {
    const printerId = assignments[row.unit.token];
    return printerId != null && workspace.printers.some((printer) => printer.id === printerId);
  });

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
    field: "source_layer" | "role" | "source_directory" | "filament_color_id",
    value: string,
    printerId: string | null,
  ) => {
    assignmentsEdited.current = true;
    setAssignments((current) => Object.fromEntries(rows.map((row) => [
      row.unit.token,
      row.unit[field] === value ? printerId : current[row.unit.token] ?? null,
    ])));
  };

  const groupSelect = (
    field: "source_layer" | "role" | "source_directory" | "filament_color_id",
    value: string,
    label: string,
  ) => (
    <label key={`${field}:${value}`} className="grid gap-1 text-xs font-medium">
      {label}
      <select
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        value=""
        disabled={submitting}
        onChange={(event) => fillGroup(field, value, event.target.value || null)}
      >
        <option value="">Choose Printer</option>
        {workspace.printers.map((printer) => (
          <option key={printer.id} value={printer.id}>{printer.name} · {printer.model}</option>
        ))}
      </select>
    </label>
  );

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
      {workspace.printers.length > 0 ? (
        <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold">Fill by Source layer</p>
            <div className="grid gap-2">
              {sourceLayers.map((sourceLayer) => groupSelect(
                "source_layer",
                sourceLayer,
                `Assign ${sourceLayer || "Unlabelled"} Source layer`,
              ))}
            </div>
          </div>
          {directories.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold">Fill by source directory</p>
              <div className="grid gap-2">
                {directories.map((directory) => groupSelect("source_directory", directory, `Assign ${directory}`))}
              </div>
            </div>
          ) : null}
          {colors.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold">Fill by color</p>
              <div className="grid gap-2">
                {colors.map((color) => groupSelect("filament_color_id", color, `Assign ${color}`))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <p className="text-xs font-semibold">Fill by role</p>
            <div className="grid gap-2">
              {roles.map((role) => groupSelect("role", role, `Assign ${role || "Unlabelled"} role`))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="divide-y divide-border rounded-md border border-border">
        {rows.map(({ unit }) => (
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
                onChange={(event) => setAssignments((current) => ({
                  ...current,
                  [unit.token]: event.target.value || null,
                }))}
                onInput={() => { assignmentsEdited.current = true; }}
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
