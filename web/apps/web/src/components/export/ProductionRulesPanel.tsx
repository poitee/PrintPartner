import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  ProductionGroupingField,
  ProductionGroupingRule,
} from "@print-partner/contracts";
import { toast } from "sonner";
import { fetchPrinters, type PrinterMachine } from "../../api/engine";
import { isAcceptedPlateStaleError } from "../../api/endpoints/acceptedPlates";
import {
  useAcceptedPlateRevisionPending,
  useAcceptedPlateWorkspaceQuery,
  useInitializeAcceptedPlatesMutation,
} from "../../queries/acceptedPlates";
import { useProductionSetup } from "../../queries/productionSetup";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const FIELD_LABELS: Record<ProductionGroupingField, string> = {
  material: "material",
  color: "color",
  source_directory: "source directory",
  source_layer: "source layer",
  role: "part role",
  part: "individual part",
};

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `rule-${Date.now().toString(36)}`;
}

export default function ProductionRulesPanel({ profileId }: { profileId: number }) {
  const setup = useProductionSetup(profileId);
  const workspaceQuery = useAcceptedPlateWorkspaceQuery(profileId);
  const initialize = useInitializeAcceptedPlatesMutation(profileId);
  const revisionWritePending = useAcceptedPlateRevisionPending(profileId);
  const [kind, setKind] = useState<ProductionGroupingRule["kind"]>("separate_by");
  const [field, setField] = useState<ProductionGroupingField>("material");
  const [value, setValue] = useState("");
  const [printerId, setPrinterId] = useState("");
  const [materialType, setMaterialType] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [printers, setPrinters] = useState<PrinterMachine[]>([]);

  const regeneratePlates = async () => {
    const workspace = workspaceQuery.data;
    if (workspace?.kind !== "ready") return;
    if (workspace.unassigned.length > 0) {
      toast.error("Assign every unit to a printer before regenerating Plates.");
      return;
    }
    const assignments = [
      ...workspace.plates.flatMap((plate) => plate.units.map((unit) => ({
        token: unit.token,
        printer_id: plate.printer.id,
      }))),
      ...workspace.unplaced.map((unit) => ({
        token: unit.token,
        printer_id: unit.printer_id,
      })),
    ];
    try {
      await initialize.mutateAsync({
        expected: workspace.basis,
        expected_plate_revision_id: workspace.plate_revision_id,
        assignments,
      });
      toast.success("Plates regenerated using the current rules.");
    } catch (error) {
      if (isAcceptedPlateStaleError(error)) {
        await workspaceQuery.refetch();
        toast.error("Newer Plate state replaced this edit. Refresh and try again.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Could not regenerate Plates.");
    }
  };

  useEffect(() => {
    void fetchPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, []);

  const saveRules = async (rules: ProductionGroupingRule[]) => {
    const current = setup.data;
    if (!current) return;
    try {
      await setup.save({
        preferred_slicer_instance_id: current.preferred_slicer_instance_id,
        selection: current.selection,
        printer_assignments: current.printer_assignments,
        rules,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save grouping rules.");
    }
  };

  const addRule = () => {
    const base = { id: newId(), enabled: true, field };
    let rule: ProductionGroupingRule;
    if (kind === "separate_by") {
      rule = { ...base, kind };
    } else if (kind === "keep_together") {
      if (!value.trim()) return toast.error("Enter the value to keep together.");
      rule = { ...base, kind, value: value.trim() };
    } else if (kind === "assign_to_printer") {
      if (!value.trim() || !printerId) {
        return toast.error("Choose a matching value and printer.");
      }
      rule = { ...base, kind, value: value.trim(), printer_id: printerId };
    } else {
      if (!value.trim() || !materialType.trim()) {
        return toast.error("Enter a matching value and material type.");
      }
      if (field === "material") {
        return toast.error("Choose what identifies the parts, then assign their material.");
      }
      rule = {
        ...base,
        kind: "set_material",
        field,
        value: value.trim(),
        material_type: materialType.trim().toUpperCase(),
      };
    }
    const currentRules = setup.data?.rules ?? [];
    void saveRules(editingId
      ? currentRules.map((current) => current.id === editingId ? { ...rule, id: editingId } : current)
      : [...currentRules, rule]);
    setValue("");
    setMaterialType("");
    setEditingId(null);
  };

  const editRule = (rule: ProductionGroupingRule) => {
    setEditingId(rule.id);
    setKind(rule.kind);
    setField(rule.field);
    setValue("value" in rule ? rule.value : "");
    setPrinterId(rule.kind === "assign_to_printer" ? rule.printer_id : "");
    setMaterialType(rule.kind === "set_material" ? rule.material_type : "");
  };

  const updateRule = (index: number, replacement: ProductionGroupingRule | null) => {
    const rules = [...(setup.data?.rules ?? [])];
    if (replacement) rules[index] = replacement;
    else rules.splice(index, 1);
    void saveRules(rules);
  };

  const moveRule = (index: number, offset: -1 | 1) => {
    const rules = [...(setup.data?.rules ?? [])];
    const target = index + offset;
    if (target < 0 || target >= rules.length) return;
    [rules[index], rules[target]] = [rules[target]!, rules[index]!];
    void saveRules(rules);
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="gap-1 pb-3">
        <CardTitle level={3} className="text-[13.5px] font-semibold">Plate grouping rules</CardTitle>
        <CardDescription>
          Rules are saved per Build. Order matters, and drag or exact-position edits remain available after arranging.
          A keep-together group gets dedicated Plates; if it cannot fit on one Plate, it is split across as few Plates as possible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {workspaceQuery.data?.kind === "ready" ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Apply rules to the current Plates</p>
              <p className="text-xs text-muted-foreground">
                Regeneration repacks every assigned unit and replaces manual Plate positions.
                {workspaceQuery.data.unassigned.length > 0
                  ? " Assign all units first."
                  : " Your current printer assignments are preserved."}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void regeneratePlates()}
              disabled={
                setup.saving ||
                initialize.isPending ||
                revisionWritePending ||
                workspaceQuery.data.unassigned.length > 0
              }
              loading={initialize.isPending}
            >
              Regenerate plates
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2 md:grid-cols-[1.15fr_1fr_1.4fr_auto]">
          <Select value={kind} onValueChange={(next) => setKind(next as ProductionGroupingRule["kind"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="separate_by">Separate by</SelectItem>
              <SelectItem value="keep_together">Keep matching parts together</SelectItem>
              <SelectItem value="assign_to_printer">Assign matching parts to printer</SelectItem>
              <SelectItem value="set_material">Set material for matching parts</SelectItem>
            </SelectContent>
          </Select>
          <Select value={field} onValueChange={(next) => setField(next as ProductionGroupingField)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(FIELD_LABELS).map(([id, label]) => (
                <SelectItem key={id} value={id}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {kind === "separate_by" ? <div /> : kind === "assign_to_printer" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Matching value, e.g. XY" />
              <Select value={printerId} onValueChange={setPrinterId}>
                <SelectTrigger><SelectValue placeholder="Printer" /></SelectTrigger>
                <SelectContent>{printers.map((printer) => (
                  <SelectItem key={printer.id} value={printer.id}>{printer.name}</SelectItem>
                ))}</SelectContent>
              </Select>
            </div>
          ) : kind === "set_material" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Matching value, e.g. XY" />
              <Input value={materialType} onChange={(event) => setMaterialType(event.target.value)} placeholder="Material, e.g. ABS" />
            </div>
          ) : (
            <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Matching value, e.g. XY" />
          )}
          <Button type="button" onClick={addRule} disabled={setup.isPending || setup.saving}>
            <Plus className="mr-1 h-4 w-4" /> {editingId ? "Save changes" : "Add rule"}
          </Button>
        </div>

        {(setup.data?.rules.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No custom rules. The arranger uses printer fit and keeps each unit editable.</p>
        ) : (
          <ol className="divide-y rounded-md border">
            {setup.data!.rules.map((rule, index) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2 p-3">
                <Switch
                  checked={rule.enabled}
                  aria-label={`Enable rule ${index + 1}`}
                  onCheckedChange={(enabled) => updateRule(index, { ...rule, enabled })}
                />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{index + 1}. {rule.kind.replaceAll("_", " ")}</span>{" "}
                  {FIELD_LABELS[rule.field]}
                  {"value" in rule ? ` “${rule.value}”` : ""}
                  {rule.kind === "assign_to_printer"
                    ? ` → ${printers.find((printer) => printer.id === rule.printer_id)?.name ?? rule.printer_id}`
                    : rule.kind === "set_material"
                      ? ` → ${rule.material_type}`
                    : ""}
                </span>
                <Button type="button" size="icon" variant="ghost" aria-label="Move rule up" disabled={index === 0} onClick={() => moveRule(index, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Move rule down" disabled={index === setup.data!.rules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Edit rule" onClick={() => editRule(rule)}><Pencil className="h-4 w-4" /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Delete rule" onClick={() => updateRule(index, null)}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
