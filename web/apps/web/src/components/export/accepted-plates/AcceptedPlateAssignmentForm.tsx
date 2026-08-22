import { useMemo, useState } from "react";
import type {
  AcceptedPlateWorkspace,
  InitializeAcceptedPlatesRequest,
} from "@print-partner/contracts";
import { Button } from "../../ui/button";

type AssignmentWorkspace = Extract<AcceptedPlateWorkspace, { kind: "setup" | "ready" }>;

type Props = Readonly<{
  workspace: AssignmentWorkspace;
  submitting: boolean;
  selectedTokens?: ReadonlySet<string>;
  onSubmit: (request: InitializeAcceptedPlatesRequest) => Promise<void>;
  onCancel?: () => void;
}>;

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
  submitting,
  selectedTokens,
  onSubmit,
  onCancel,
}: Props) {
  const rows = useMemo(() => {
    const all = assignmentRows(workspace);
    if (selectedTokens == null) return all;
    return all.filter((row) => selectedTokens.has(row.unit.token));
  }, [selectedTokens, workspace]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(rows.map((row) => [row.unit.token, row.printerId])),
  );
  const sourceLayers = useMemo(() => [...new Set(rows.map((row) => row.unit.source_layer))], [rows]);
  const roles = useMemo(() => [...new Set(rows.map((row) => row.unit.role))], [rows]);
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
    field: "source_layer" | "role",
    value: string,
    printerId: string | null,
  ) => {
    setAssignments((current) => Object.fromEntries(rows.map((row) => [
      row.unit.token,
      row.unit[field] === value ? printerId : current[row.unit.token] ?? null,
    ])));
  };

  const groupSelect = (
    field: "source_layer" | "role",
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
                {unit.source_layer} · {unit.role}
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
