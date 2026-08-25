import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCompatibility } from "../assistant/compatibility.js";
import {
  conflictsForStack,
  explainSource,
  findCatalogDomainMismatches,
  replacementsWhenAdding,
} from "./interaction-graph.js";
import { resolveStackPresetId } from "./stack-preset.js";
import { loadKitCatalog } from "./kit-catalog.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/kit-workspace",
);
const opts = { dataDir: FIXTURE };

describe("interaction graph", () => {
  it("explains that two probes in the same pick_one slot conflict", () => {
    const probe = explainSource("Example-Probe", opts);
    expect(probe).not.toBeNull();
    expect(probe!.conflicts_with).toEqual(expect.arrayContaining(["Example-Alt-Probe"]));
    expect(probe!.replaces_slots).toEqual(expect.arrayContaining(["probe"]));
  });

  it("flags two probes on the same stack", () => {
    const result = conflictsForStack(
      ["Example-Printer", "Example-Probe", "Example-Alt-Probe"],
      opts,
    );
    expect(
      result.conflicts.some((c) => c.a.includes("Probe") || c.b.includes("Probe")),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "compat_conflict" || w.code === "compat_slot",
      ),
    ).toBe(true);
  });

  it("surfaces vendor-supplement replacement edges", () => {
    const check = replacementsWhenAdding("Example-Vendor-Kit", ["Example-Printer"], opts);
    expect(check.suggested_excludes.length + check.warnings.length).toBeGreaterThan(0);
    const explained = explainSource("Example-Vendor-Kit", opts);
    expect(explained!.replaces_parts.length + explained!.replaces.length).toBeGreaterThan(0);
    expect(
      explained!.replaces.some((r) => /power_inlet|inlet/i.test(r)) ||
        explained!.replaces_parts.some((p) =>
          /power_inlet|inlet/i.test(p.from_slug_or_path),
        ),
    ).toBe(true);
  });

  it("normalizes compat@1 and legacy sketch fields", () => {
    const a = normalizeCompatibility({
      schema: "print-partner/compat@1",
      source_name: "Example-Probe",
      kind: "addon_probe",
      attaches_to: [{ base: "Example-Printer" }],
      conflicts: ["Example-Alt-Probe"],
      replaces: ["nozzle_probe.stl"],
    });
    expect(a!.attaches_to_bases).toContain("Example-Printer");
    expect(a!.conflicts_with).toContain("Example-Alt-Probe");
    expect(a!.replaces_slots).toContain("probe");

    const b = normalizeCompatibility({
      source_name: "Example-Toolhead",
      attaches_to_bases: ["Example-Printer"],
      conflicts_with: ["Example-Extruder"],
    });
    expect(b!.attaches_to_bases).toContain("Example-Printer");
    expect(b!.conflicts_with).toContain("Example-Extruder");
  });

  it("resolves a preset id by label as well as by key", () => {
    const catalog = loadKitCatalog(FIXTURE) as {
      stack_presets?: Record<string, { base_tag?: string; label?: string }>;
    };
    const presets = catalog.stack_presets ?? {};
    expect(resolveStackPresetId("example_kit_r2", presets)).toBe("example_kit_r2");
    expect(resolveStackPresetId("Example Kit R2", presets)).toBe("example_kit_r2");
    expect(presets.example_kit_r2?.base_tag).toBe("EX-R2");
  });

  it("never invents a preset id that the catalog does not define", () => {
    const presets =
      (loadKitCatalog(FIXTURE) as { stack_presets?: Record<string, { label?: string }> })
        .stack_presets ?? {};
    expect(resolveStackPresetId("some_other_kit_r2", presets)).toBeNull();
  });

  it("maintainer check runs without throwing", () => {
    const issues = findCatalogDomainMismatches(opts);
    expect(Array.isArray(issues)).toBe(true);
    // pick_one probe peers declare conflicts in the fixture pack, so no gap.
    const probeGap = issues.find(
      (i) =>
        i.category === "probe" &&
        ((i.a === "Example-Probe" && i.b === "Example-Alt-Probe") ||
          (i.a === "Example-Alt-Probe" && i.b === "Example-Probe")),
    );
    expect(probeGap).toBeUndefined();
  });

  it("is empty against the shipped data, which carries no sources", () => {
    expect(explainSource("Example-Probe", { dataDir: null })).toBeNull();
    expect(findCatalogDomainMismatches({ dataDir: null })).toEqual([]);
  });
});
