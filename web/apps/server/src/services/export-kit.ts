import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { zipSync } from "fflate";
import { safePlanSlug } from "@print-partner/domain";
import type { KitManifestRecord } from "./kit-manifest-store.js";
import type { AcceptedOperationalExport } from "./accepted-operational-export.js";
import { writeAcceptedExportFile } from "./accepted-export-publication.js";

const KIT_FORMAT = "print-partner-kit";
const KIT_VERSION = 3;
const KIT_JSON_NAME = "kit.json";

export type KitBundlePartWithoutProgress = Readonly<{
  matchKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  role: string;
  filamentColorId: string | null;
  filamentCustomHex: string | null;
  quantityInferred: number;
  quantityOverride: number | null;
  quantityEffective: number;
  included: boolean;
  notes: string;
  geometrySame: boolean | null;
  requirement: string | null;
  optionGroupId: string | null;
  manifestSource: string | null;
}>;

export type EditableKitRecipe = Readonly<{
  profile: Readonly<{ id: number; name: string; orderNumber: string | null }>;
  layers: readonly Record<string, unknown>[];
  sources: readonly Record<string, unknown>[];
  kitManifest: KitManifestRecord;
  workingParts: readonly KitBundlePartWithoutProgress[];
}>;

export type KitBundleMode =
  | { readonly kind: "editable"; readonly recipe: EditableKitRecipe }
  | {
      readonly kind: "accepted_progress";
      readonly recipe: EditableKitRecipe;
      readonly accepted: AcceptedOperationalExport | null;
    };

function partData(part: KitBundlePartWithoutProgress): Record<string, unknown> {
  return {
    match_key: part.matchKey,
    relative_path: part.relativePath,
    filename: part.filename,
    source_layer: part.sourceLayer,
    status: part.status,
    role: part.role,
    filament_color_id: part.filamentColorId,
    filament_custom_hex: part.filamentCustomHex,
    quantity_auto: part.quantityInferred,
    quantity_override: part.quantityOverride,
    quantity_effective: part.quantityEffective,
    included: part.included,
    notes: part.notes,
    geometry_same: part.geometrySame,
    requirement: part.requirement,
    option_group_id: part.optionGroupId,
    manifest_source: part.manifestSource,
  };
}

function acceptedPartData(
  part: AcceptedOperationalExport["parts"][number],
): Record<string, unknown> {
  return {
    match_key: part.partKey,
    relative_path: part.relativePath,
    filename: part.filename,
    source_layer: part.sourceLayer,
    status: part.status,
    role: part.role,
    filament_color_id: part.filamentColorId,
    filament_custom_hex: part.filamentCustomHex,
    quantity_auto: part.quantityInferred,
    quantity_override: part.quantityOverride,
    quantity_effective: part.quantityEffective,
    included: part.included,
    notes: part.notes,
    geometry_same: part.geometrySame,
    requirement: part.requirement,
    option_group_id: part.optionGroupId,
    manifest_source: part.manifestSource,
    print_units: part.units.map((unit) => unit.completed),
  };
}

export function buildKitBundleData(input: Readonly<{
  mode: KitBundleMode;
  exportedAt: string;
}>): Record<string, unknown> {
  const { recipe } = input.mode;
  const parts = input.mode.kind === "editable"
    ? recipe.workingParts.map(partData)
    : input.mode.accepted?.parts.map(acceptedPartData) ?? [];
  return {
    format: KIT_FORMAT,
    version: KIT_VERSION,
    exported_at: input.exportedAt,
    profile: { name: recipe.profile.name, order_number: recipe.profile.orderNumber },
    layers: recipe.layers,
    parts,
    kit_manifest: recipe.kitManifest,
    sources: recipe.sources,
  };
}

export function writeKitBundleData(input: Readonly<{
  data: Record<string, unknown>;
  profileId: number;
  profileName: string;
  exportsDir: string;
}>): string {
  const payload = new TextEncoder().encode(JSON.stringify(input.data, null, 2));
  const zipped = zipSync({ [KIT_JSON_NAME]: payload });
  const slug = safePlanSlug(input.profileName).slice(0, 80);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const digest = createHash("sha256").update(zipped).digest("hex");
  return writeAcceptedExportFile({
    root: input.exportsDir,
    directorySegments: [`profile-${input.profileId}-${slug}`, "kit"],
    filename: `${slug}-${stamp}-${digest}.print-partner-kit.zip`,
    bytes: zipped,
  });
}

function parseKitBundleRaw(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data.format !== KIT_FORMAT) throw new Error("Not a Print Partner kit file");
  const version = Number(data.version ?? 0);
  if (![1, 2, 3].includes(version)) throw new Error("Unsupported kit version");
  return data;
}

/** Parse kit.json or .print-partner-kit.zip bytes from a browser upload. */
export function parseKitBundleBuffer(buf: Buffer, filename?: string): Record<string, unknown> {
  const name = (filename ?? "").toLowerCase();
  const looksZip =
    name.endsWith(".zip") ||
    name.includes(".print-partner-kit") ||
    (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b);
  if (looksZip) {
    const zip = new AdmZip(buf);
    const entry = zip.getEntry(KIT_JSON_NAME);
    if (!entry) throw new Error(`Missing ${KIT_JSON_NAME} in kit archive`);
    return parseKitBundleRaw(entry.getData().toString("utf8"));
  }
  return parseKitBundleRaw(buf.toString("utf8"));
}

export function loadKitBundleBytes(path: string): Record<string, unknown> {
  const buf = readFileSync(path);
  return parseKitBundleBuffer(buf, path);
}

export { KIT_FORMAT, KIT_VERSION };
