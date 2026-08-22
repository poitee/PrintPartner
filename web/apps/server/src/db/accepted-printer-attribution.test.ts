import { describe, expect, it } from "vitest";
import type { AcceptedPlanOperationalSnapshot } from "./accepted-plan-operational.js";
import { resolveAcceptedPrinterAttribution } from "./accepted-printer-attribution.js";

const token = (value: number): string => `ppu_${value.toString(16).padStart(32, "0")}`;

function snapshot(
  parts: Array<{
    id: number;
    filename: string;
    included?: boolean;
    units: Array<{
      index: number;
      token: string;
      objectName?: string;
      required?: boolean;
      completed?: boolean;
    }>;
  }>,
): AcceptedPlanOperationalSnapshot {
  return {
    format: "accepted-plan-operational-v1",
    profile: {
      id: 7,
      name: "Accepted",
      orderNumber: null,
      specialRequest: null,
      archivedAt: null,
    },
    planVersion: 3,
    revisionId: 11,
    revisionNumber: 2,
    revisionDigest: "a".repeat(64),
    acceptedAt: "2026-08-21T12:00:00.000Z",
    provenance: { kind: "legacy" },
    requiredUnitMappingDigest: "b".repeat(64),
    parts: parts.map((part) => ({
      revisionPartId: part.id + 100,
      projectionPartId: part.id,
      partKey: `part-${part.id}`,
      relativePath: `parts/${part.filename}`,
      filename: part.filename,
      sourceLayer: "default",
      status: "required",
      roleInferred: "other",
      roleOverride: null,
      effectiveRole: "other",
      filamentColorId: null,
      filamentCustomHex: null,
      spoolmanSpoolId: null,
      quantityInferred: part.units.length,
      quantityOverride: null,
      quantityEffective: part.units.length,
      included: part.included ?? true,
      notes: "",
      githubBlobUrl: null,
      geometrySame: null,
      requirement: null,
      optionGroupId: null,
      manifestSource: null,
      artifact: { kind: "unavailable", reason: "legacy" },
      units: part.units.map((unit) => ({
        unitIndex: unit.index,
        required: unit.required ?? true,
        token: unit.token,
        objectName: unit.objectName ?? `part_${part.id}__${unit.token}`,
        completed: unit.completed ?? false,
        assembled: false,
      })),
    })),
  };
}

describe("accepted printer attribution", () => {
  it("maps an exact case-insensitive Required-unit Object name", () => {
    const accepted = snapshot([
      {
        id: 41,
        filename: "bracket.stl",
        units: [{ index: 1, token: token(1), objectName: `Bracket__${token(1)}` }],
      },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: [`BRACKET__${token(1).toUpperCase()}`],
    });

    expect(result.units).toEqual([{ part_id: 41, unit_index: 1 }]);
    expect(result.outcomes).toEqual([
      {
        inputIndex: 0,
        rawName: `BRACKET__${token(1).toUpperCase()}`,
        kind: "required_object_name",
        unit: { part_id: 41, unit_index: 1 },
      },
    ]);
    expect(result.expected).toMatchObject({
      profileId: 7,
      planVersion: 3,
      revisionId: 11,
    });
  });

  it("maps known slicer wrappers and a unique accepted filename", () => {
    const accepted = snapshot([
      {
        id: 5,
        filename: "frame.stl",
        units: [
          { index: 0, token: token(2), objectName: `frame__${token(2)}` },
          { index: 1, token: token(3), objectName: `frame__${token(3)}` },
        ],
      },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: [`frame__${token(2)}_id_0_copy_0`, "frame.stl (Instance 2)"],
    });

    expect(result.units).toEqual([
      { part_id: 5, unit_index: 0 },
      { part_id: 5, unit_index: 1 },
    ]);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      "required_object_name",
      "legacy_filename",
    ]);
  });

  it("reserves exact Object identity before earlier legacy filename occurrences", () => {
    const accepted = snapshot([
      {
        id: 5,
        filename: "frame.stl",
        units: [
          { index: 0, token: token(2), objectName: `frame__${token(2)}` },
          { index: 1, token: token(3), objectName: `frame__${token(3)}` },
        ],
      },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: ["frame.stl", `frame__${token(2)}`],
    });

    expect(result.outcomes).toEqual([
      {
        inputIndex: 0,
        rawName: "frame.stl",
        kind: "legacy_filename",
        unit: { part_id: 5, unit_index: 1 },
      },
      {
        inputIndex: 1,
        rawName: `frame__${token(2)}`,
        kind: "required_object_name",
        unit: { part_id: 5, unit_index: 0 },
      },
    ]);
  });

  it("does not guess between duplicate accepted filenames", () => {
    const accepted = snapshot([
      { id: 1, filename: "bracket.stl", units: [{ index: 0, token: token(1) }] },
      { id: 2, filename: "bracket.stl", units: [{ index: 0, token: token(2) }] },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: ["bracket.stl"],
    });

    expect(result.units).toEqual([]);
    expect(result.outcomes).toEqual([
      { inputIndex: 0, rawName: "bracket.stl", kind: "ambiguous_filename" },
    ]);
  });

  it("selects only included required incomplete units", () => {
    const accepted = snapshot([
      {
        id: 1,
        filename: "frame.stl",
        units: [
          { index: 0, token: token(1), completed: true },
          { index: 1, token: token(2), required: false },
          { index: 2, token: token(3) },
        ],
      },
      {
        id: 2,
        filename: "other.stl",
        included: false,
        units: [{ index: 0, token: token(4) }],
      },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: ["frame.stl", "frame.stl", "frame.stl", "other.stl"],
    });

    expect(result.units).toEqual([{ part_id: 1, unit_index: 2 }]);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      "legacy_filename",
      "unmatched",
      "unmatched",
      "unmatched",
    ]);
  });

  it("preserves unmatched duplicate occurrences in input order", () => {
    const accepted = snapshot([
      {
        id: 1,
        filename: "frame.stl",
        units: [{ index: 0, token: token(1), objectName: `frame__${token(1)}` }],
      },
    ]);
    const name = `frame__${token(1)}`;

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: [name, name, "unknown", name],
    });

    expect(result.units).toEqual([{ part_id: 1, unit_index: 0 }]);
    expect(result.outcomes.map(({ rawName, kind }) => ({ rawName, kind }))).toEqual([
      { rawName: name, kind: "required_object_name" },
      { rawName: name, kind: "duplicate_observation" },
      { rawName: "unknown", kind: "unmatched" },
      { rawName: name, kind: "duplicate_observation" },
    ]);
    expect(result.unmatchedObjectNames).toEqual([name, "unknown", name]);
  });

  it("suppresses fallback for a recognized completed canonical name", () => {
    const accepted = snapshot([
      {
        id: 1,
        filename: "complete.stl",
        units: [
          {
            index: 0,
            token: token(1),
            objectName: `complete__${token(1)}`,
            completed: true,
          },
        ],
      },
      { id: 2, filename: "fallback.stl", units: [{ index: 0, token: token(2) }] },
    ]);

    const result = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: [`complete__${token(1)}`],
      fallbackFilename: "fallback.gcode",
    });

    expect(result.units).toEqual([]);
    expect(result.fallback).toBe("recognized_observation");
    expect(result.outcomes[0]).toMatchObject({ kind: "already_completed" });
  });

  it("uses fallback only after object names map no units", () => {
    const accepted = snapshot([
      { id: 1, filename: "bracket.stl", units: [{ index: 0, token: token(1) }] },
    ]);

    const fallback = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: ["unknown", "unknown"],
      fallbackFilename: "bracket.bgcode",
    });
    expect(fallback.units).toEqual([{ part_id: 1, unit_index: 0 }]);
    expect(fallback.fallback).toBe("used");
    expect(fallback.unmatchedObjectNames).toEqual(["unknown", "unknown"]);

    const mapped = resolveAcceptedPrinterAttribution(accepted, {
      objectNames: ["bracket.stl"],
      fallbackFilename: "bracket.bgcode",
    });
    expect(mapped.units).toEqual([{ part_id: 1, unit_index: 0 }]);
    expect(mapped.fallback).toBe("unused");
  });

  it("does not mutate the snapshot or observed names", () => {
    const accepted = snapshot([
      { id: 1, filename: "bracket.stl", units: [{ index: 0, token: token(1) }] },
    ]);
    const names = Object.freeze(["bracket.stl", "unknown"]);
    Object.freeze(accepted.parts);
    const before = JSON.stringify({ accepted, names });

    resolveAcceptedPrinterAttribution(accepted, {
      objectNames: names,
      fallbackFilename: "fallback.gcode",
    });

    expect(JSON.stringify({ accepted, names })).toBe(before);
  });
});
