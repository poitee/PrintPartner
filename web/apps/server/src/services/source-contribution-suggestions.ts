import { createHash } from "node:crypto";
import type { SourceContribution } from "./build-planning.js";

const GENERIC_PATH_SEGMENTS = new Set([
  "stl",
  "stls",
  "model",
  "models",
  "part",
  "parts",
  "printable",
  "printables",
  "files",
  "src",
]);

const SLOT_TERMS: ReadonlyArray<{
  slot: string;
  terms: readonly string[];
}> = [
  { slot: "hotend", terms: ["hotend", "rapido", "revo", "dragon", "uhf"] },
  { slot: "extruder", terms: ["extruder", "g2e", "galileo", "clockwork"] },
  { slot: "probe", terms: ["probe", "beacon", "klicky", "tap"] },
  {
    slot: "toolhead_electronics",
    terms: ["toolboard", "canboard", "ebb36", "ebb42", "sb2209", "nighthawk"],
  },
  {
    slot: "cable_routing",
    terms: ["umbilical", "strain_relief", "cable", "chain_anchor"],
  },
  { slot: "controller", terms: ["controller", "octopus", "leviathan", "skr"] },
  { slot: "toolhead", terms: ["toolhead", "stealthburner", "printhead"] },
];

function slotName(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "general_parts";
}

function pathParts(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

function suggestedSlot(path: string, knownSlots: ReadonlySet<string>): {
  slot: string;
  confidence: SourceContribution["confidence"];
} {
  const searchable = slotName(path);
  for (const candidate of SLOT_TERMS) {
    if (
      knownSlots.has(candidate.slot) &&
      candidate.terms.some((term) => searchable.includes(term))
    ) {
      return { slot: candidate.slot, confidence: "high" };
    }
  }
  const candidate = pathParts(path)
    .slice(0, -1)
    .map(slotName)
    .find((part) => !GENERIC_PATH_SEGMENTS.has(part));
  return {
    slot: candidate ?? "general_parts",
    confidence: candidate ? "medium" : "low",
  };
}

export function suggestSourceContributions(input: {
  evidenceId: string;
  sourceName: string;
  printablePaths: readonly string[];
  knownSlots: readonly string[];
}): SourceContribution[] {
  const knownSlots = new Set(input.knownSlots);
  const groups = new Map<
    string,
    { confidence: SourceContribution["confidence"]; scopes: Set<string>; count: number }
  >();
  for (const path of input.printablePaths) {
    const normalizedPath = path.replaceAll("\\", "/");
    const parts = pathParts(normalizedPath);
    if (parts.length === 0) continue;
    const directory = parts.slice(0, -1).join("/");
    const suggestion = suggestedSlot(normalizedPath, knownSlots);
    const current = groups.get(suggestion.slot) ?? {
      confidence: suggestion.confidence,
      scopes: new Set<string>(),
      count: 0,
    };
    current.count += 1;
    current.scopes.add(directory ? `${directory}/**` : parts[0]!);
    if (suggestion.confidence === "high") current.confidence = "high";
    groups.set(suggestion.slot, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, group]) => ({
      id: createHash("sha256")
        .update(`${input.evidenceId}\0${slot}\0${[...group.scopes].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 24),
      evidence_id: input.evidenceId,
      slot,
      responsibility: "printable_parts",
      path_scopes: [...group.scopes].sort(),
      confidence: group.confidence,
      evidence_text: `${input.sourceName} contains ${group.count} printable file${group.count === 1 ? "" : "s"} under the proposed ${slot} responsibility.`,
      status: "proposed",
    }));
}
