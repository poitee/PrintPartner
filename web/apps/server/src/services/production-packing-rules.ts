import {
  productionSetupSchema,
  type ProductionGroupingField,
  type ProductionGroupingRule,
} from "@print-partner/contracts";

export type ProductionPackingUnit = Readonly<{
  token: string;
  objectName: string;
  filename: string;
  sourceDirectory: string;
  sourceLayer: string;
  role: string;
  filamentColorId: string | null;
  filamentCustomHex?: string | null;
  materialType?: string | null;
}>;

function colorValue(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "unassigned";
  const hex = trimmed.replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(hex)
    ? `hex:${hex}`
    : `id:${trimmed}`;
}

function fieldValue(unit: ProductionPackingUnit, field: ProductionGroupingField): string {
  if (field === "material") return unit.materialType ?? "unassigned";
  if (field === "color") {
    const catalogColor = unit.filamentColorId?.trim();
    return colorValue(catalogColor || unit.filamentCustomHex);
  }
  if (field === "source_directory") return unit.sourceDirectory || "unassigned";
  if (field === "source_layer") return unit.sourceLayer || "unassigned";
  if (field === "role") return unit.role || "unassigned";
  return unit.objectName || unit.filename;
}

function ruleFieldValue(field: ProductionGroupingField, value: string): string {
  return field === "color" ? colorValue(value) : value;
}

function withAssignedMaterial(
  unit: ProductionPackingUnit,
  rules: readonly ProductionGroupingRule[],
): ProductionPackingUnit {
  const materialRule = rules.find((rule) =>
    rule.enabled && rule.kind === "set_material" &&
    fieldValue(unit, rule.field) === ruleFieldValue(rule.field, rule.value)
  );
  return materialRule?.kind === "set_material"
    ? { ...unit, materialType: materialRule.material_type }
    : unit;
}

export function productionPackingBuckets<T extends ProductionPackingUnit>(
  units: readonly T[],
  rules: readonly ProductionGroupingRule[],
): T[][] {
  const groupingRules = rules.filter((rule) =>
    rule.enabled && (rule.kind === "separate_by" || rule.kind === "keep_together")
  );
  if (groupingRules.length === 0) return units.length > 0 ? [[...units]] : [];

  const buckets = new Map<string, T[]>();
  for (const unit of units) {
    const effectiveUnit = withAssignedMaterial(unit, rules);
    const key = groupingRules.map((rule) => {
      const value = fieldValue(effectiveUnit, rule.field);
      if (rule.kind === "separate_by") return `${rule.id}:value:${value}`;
      return value === ruleFieldValue(rule.field, rule.value)
        ? `${rule.id}:match`
        : `${rule.id}:other`;
    }).join("\u0000");
    const bucket = buckets.get(key) ?? [];
    bucket.push(unit);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

export function loadProductionPackingRules(
  raw: string | null | undefined,
  profileId: number,
): readonly ProductionGroupingRule[] {
  if (!raw) return [];
  try {
    const parsed = productionSetupSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.profile_id === profileId ? parsed.data.rules : [];
  } catch {
    return [];
  }
}
