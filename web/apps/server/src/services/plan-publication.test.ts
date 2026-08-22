import { describe, expect, it } from "vitest";
import type { PlanDraftPart, PlanDraftSnapshot } from "./plan-drafts.js";
import {
  AcceptedOperationalRowTextLimitError,
  MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
  preparePlanPublication,
  publishedPlanPartsMatch,
  validateAcceptedOperationalTextRow,
} from "./plan-publication.js";

function part(id: number, quantityEffective = 1): PlanDraftPart {
  return {
    id,
    draftId: 9,
    baseRevisionPartId: id + 100,
    partKey: `part-${id}`,
    relativePath: `parts/${id}.stl`,
    filename: `${id}.stl`,
    sourceLayer: "base:Source",
    status: "base",
    roleInferred: "primary",
    roleOverride: null,
    filamentColorId: null,
    filamentCustomHex: null,
    spoolmanSpoolId: null,
    quantityInferred: quantityEffective,
    quantityOverride: null,
    quantityEffective,
    included: true,
    notes: "",
    githubBlobUrl: null,
    geometrySame: null,
    requirement: null,
    optionGroupId: null,
    manifestSource: null,
    artifactDigest: "a".repeat(64),
  };
}

function draft(parts: PlanDraftPart[]): PlanDraftSnapshot {
  return {
    id: 9,
    profileId: 4,
    baseRevisionId: 3,
    basePlanVersion: 1,
    state: "open",
    lifecycleVersion: 0,
    origin: { kind: "recompute" },
    digestFormat: "plan-draft-v2",
    snapshotDigest: "d".repeat(64),
    createdBy: "test",
    idempotencyKey: "draft",
    createdAt: "2026-08-20T00:00:00.000Z",
    inputs: [],
    parts,
  };
}

describe("Plan publication preparation", () => {
  it("enforces the accepted operational UTF-8 row limit at its exact boundary", () => {
    const exact = "\u00e9".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2);

    expect(() => validateAcceptedOperationalTextRow([exact])).not.toThrow();
    expect(() => validateAcceptedOperationalTextRow([exact, "x"])).toThrowError(
      AcceptedOperationalRowTextLimitError,
    );
  });

  it("derives accepted Parts, frozen mappings, and translated progress canonically", () => {
    const first = part(21, 2);
    const second = { ...part(22), included: false, roleOverride: "accent" };
    const prepared = preparePlanPublication({
      draft: draft([second, first]),
      assignments: [
        { kind: "create", draftPartId: 22, unitIndex: 0 },
        { kind: "create", draftPartId: 21, unitIndex: 1 },
        {
          kind: "reuse",
          draftPartId: 21,
          unitIndex: 0,
          token: "ppu_00000000000000000000000000000001",
        },
      ],
      baseUnits: [
        {
          token: "ppu_00000000000000000000000000000001",
          objectName: "old__ppu_00000000000000000000000000000001",
          completed: true,
          assembled: true,
        },
      ],
    });
    expect(prepared.expectedUnitCount).toBe(3);
    expect(prepared.parts.map((value) => [value.draftPartId, value.effectiveRole])).toEqual([
      [21, "primary"],
      [22, "accent"],
    ]);
    expect(prepared.progress).toEqual([
      {
        draftPartId: 21,
        unitIndex: 0,
        assignment: "reuse",
        token: "ppu_00000000000000000000000000000001",
        completed: true,
        assembled: true,
      },
      {
        draftPartId: 21,
        unitIndex: 1,
        assignment: "create",
        token: null,
        completed: false,
        assembled: false,
      },
      {
        draftPartId: 22,
        unitIndex: 0,
        assignment: "create",
        token: null,
        completed: false,
        assembled: false,
      },
    ]);
    const renumbered = preparePlanPublication({
      draft: draft([{ ...first, id: 31 }, { ...second, id: 32 }]),
      assignments: [
        {
          kind: "reuse",
          draftPartId: 31,
          unitIndex: 0,
          token: "ppu_00000000000000000000000000000001",
        },
        { kind: "create", draftPartId: 31, unitIndex: 1 },
        { kind: "create", draftPartId: 32, unitIndex: 0 },
      ],
      baseUnits: [
        {
          token: "ppu_00000000000000000000000000000001",
          objectName: "old__ppu_00000000000000000000000000000001",
          completed: true,
          assembled: true,
        },
      ],
    });
    expect(renumbered.revisionDigest).toBe(prepared.revisionDigest);
  });

  it("rejects missing, duplicate, noncontiguous, unknown, and corrupt inputs", () => {
    const inputDraft = draft([part(21, 2)]);
    expect(() =>
      preparePlanPublication({ draft: inputDraft, assignments: [], baseUnits: [] }),
    ).toThrow(/incomplete/i);
    expect(() =>
      preparePlanPublication({
        draft: inputDraft,
        assignments: [
          { kind: "create", draftPartId: 21, unitIndex: 1 },
          { kind: "create", draftPartId: 21, unitIndex: 0 },
        ],
        baseUnits: [],
      }),
    ).not.toThrow();
    expect(() =>
      preparePlanPublication({
        draft: inputDraft,
        assignments: [
          {
            kind: "reuse",
            draftPartId: 21,
            unitIndex: 0,
            token: "ppu_00000000000000000000000000000002",
          },
          { kind: "create", draftPartId: 21, unitIndex: 1 },
        ],
        baseUnits: [],
      }),
    ).toThrow(/unknown/i);
    expect(() =>
      preparePlanPublication({
        draft: inputDraft,
        assignments: [
          { kind: "create", draftPartId: 21, unitIndex: 0 },
          { kind: "create", draftPartId: 99, unitIndex: 0 },
        ],
        baseUnits: [],
      }),
    ).toThrow(/missing/i);
    expect(() =>
      preparePlanPublication({
        draft: inputDraft,
        assignments: [
          { kind: "create", draftPartId: 21, unitIndex: 0 },
          { kind: "create", draftPartId: 21, unitIndex: 2 },
        ],
        baseUnits: [],
      }),
    ).toThrow(/contiguous/i);
    expect(() =>
      preparePlanPublication({
        draft: inputDraft,
        assignments: [
          { kind: "create", draftPartId: 21, unitIndex: 0 },
          { kind: "create", draftPartId: 21, unitIndex: 1 },
        ],
        baseUnits: [
          {
            token: "ppu_00000000000000000000000000000001",
            objectName: "old__ppu_00000000000000000000000000000001",
            completed: false,
            assembled: true,
          },
        ],
      }),
    ).toThrow(/corrupt/i);
  });

  it("verifies published Parts by explicit identity when row order differs", () => {
    const zeta = { ...part(21), filename: "zeta.stl", partKey: "zeta" };
    const alpha = { ...part(22), filename: "alpha.stl", partKey: "alpha" };
    const prepared = preparePlanPublication({
      draft: draft([zeta, alpha]),
      assignments: [
        { kind: "create", draftPartId: 21, unitIndex: 0 },
        { kind: "create", draftPartId: 22, unitIndex: 0 },
      ],
      baseUnits: [],
    });
    const revisionParts = prepared.parts
      .map((value, index) => ({
        ...value,
        id: index === 0 ? 101 : 102,
        projectionPartId: index === 0 ? 201 : 202,
      }))
      .reverse();
    const projectionParts = prepared.parts
      .map((value, index) => ({
        ...value,
        id: index === 0 ? 201 : 202,
        matchKey: value.partKey,
        role: value.effectiveRole,
        quantityAuto: value.quantityInferred,
      }))
      .reverse();
    expect(
      publishedPlanPartsMatch({
        preparedParts: prepared.parts,
        revisionParts,
        projectionParts,
        revisionPartIdByDraftPart: new Map([
          [21, 101],
          [22, 102],
        ]),
        projectionPartIdByDraftPart: new Map([
          [21, 201],
          [22, 202],
        ]),
      }),
    ).toBe(true);
  });
});
