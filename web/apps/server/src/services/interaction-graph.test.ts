import { describe, expect, it } from "vitest";
import { normalizeCompatibility } from "../assistant/compatibility.js";
import {
  conflictsForStack,
  explainSource,
  findCatalogDomainMismatches,
  replacementsWhenAdding,
} from "./interaction-graph.js";
import { resolveStackPresetId } from "./stack-preset.js";
import { loadKitCatalog } from "./kit-catalog.js";

describe("interaction graph", () => {
  it("explains Voron-Tap conflicts with Klicky-Probe", () => {
    const tap = explainSource("Voron-Tap");
    expect(tap).not.toBeNull();
    expect(tap!.conflicts_with).toEqual(
      expect.arrayContaining(["Klicky-Probe", "Boop"]),
    );
    expect(tap!.replaces_slots).toEqual(expect.arrayContaining(["probe"]));
  });

  it("flags Tap + Klicky on the same stack", () => {
    const result = conflictsForStack(["Voron-Trident", "Voron-Tap", "Klicky-Probe"]);
    expect(result.conflicts.some((c) => c.a.includes("Tap") || c.b.includes("Tap"))).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.code === "compat_conflict" || w.code === "compat_slot")).toBe(
      true,
    );
  });

  it("surfaces LDO inlet replacement edges", () => {
    const check = replacementsWhenAdding("LDOVoronTrident", ["Voron-Trident"]);
    expect(check.suggested_excludes.length + check.warnings.length).toBeGreaterThan(0);
    const explained = explainSource("LDOVoronTrident");
    expect(explained!.replaces_parts.length + explained!.replaces.length).toBeGreaterThan(0);
    expect(
      explained!.replaces.some((r) => /power_inlet|inlet/i.test(r)) ||
        explained!.replaces_parts.some((p) => /power_inlet|inlet/i.test(p.from_slug_or_path)),
    ).toBe(true);
  });

  it("normalizes compat@1 and legacy sketch fields", () => {
    const a = normalizeCompatibility({
      schema: "print-partner/compat@1",
      source_name: "Voron-Tap",
      kind: "addon_probe",
      attaches_to: [{ base: "Voron-Trident" }],
      conflicts: ["Klicky-Probe"],
      replaces: ["nozzle_probe.stl"],
    });
    expect(a!.attaches_to_bases).toContain("Voron-Trident");
    expect(a!.conflicts_with).toContain("Klicky-Probe");
    expect(a!.replaces_slots).toContain("probe");

    const b = normalizeCompatibility({
      source_name: "Voron-Stealthburner",
      attaches_to_bases: ["Voron-2"],
      conflicts_with: ["Galileo2"],
    });
    expect(b!.attaches_to_bases).toContain("Voron-2");
    expect(b!.conflicts_with).toContain("Galileo2");
  });

  it("keeps voron_trident_r2 alias → ldo_trident_r2 + VTr2", () => {
    const catalog = loadKitCatalog() as {
      stack_presets?: Record<string, { base_tag?: string; label?: string }>;
    };
    const presets = catalog.stack_presets ?? {};
    expect(resolveStackPresetId("voron_trident_r2", presets)).toBe("ldo_trident_r2");
    expect(presets.ldo_trident_r2?.base_tag).toBe("VTr2");
  });

  it("maintainer check runs without throwing", () => {
    const issues = findCatalogDomainMismatches();
    expect(Array.isArray(issues)).toBe(true);
    // Probe peers should already declare conflicts in shipped domain pack
    const probeGap = issues.find(
      (i) =>
        i.category === "probe" &&
        ((i.a === "Voron-Tap" && i.b === "Klicky-Probe") ||
          (i.a === "Klicky-Probe" && i.b === "Voron-Tap")),
    );
    expect(probeGap).toBeUndefined();
  });
});
