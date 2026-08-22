import { describe, expect, it } from "vitest";
import type { PlanDraftPart, PlanDraftSnapshot } from "./plan-drafts.js";
import {
  digestRequiredUnitDecisions,
  reconcileRequiredUnits,
  type RequiredUnitReconciliationBasePart,
} from "./required-unit-reconciliation.js";

function draftPart(input: Partial<PlanDraftPart> & Pick<PlanDraftPart, "id">): PlanDraftPart {
  return {
    id: input.id,
    draftId: 7,
    baseRevisionPartId: input.baseRevisionPartId ?? null,
    partKey: input.partKey ?? `part-${input.id}`,
    relativePath: input.relativePath ?? "",
    filename: input.filename ?? `part-${input.id}.stl`,
    sourceLayer: input.sourceLayer ?? "source",
    status: input.status ?? "base",
    roleInferred: input.roleInferred ?? "primary",
    roleOverride: input.roleOverride ?? null,
    filamentColorId: input.filamentColorId ?? null,
    filamentCustomHex: input.filamentCustomHex ?? null,
    spoolmanSpoolId: input.spoolmanSpoolId ?? null,
    quantityInferred: input.quantityInferred ?? 1,
    quantityOverride: input.quantityOverride ?? null,
    quantityEffective: input.quantityEffective ?? 1,
    included: input.included ?? true,
    notes: input.notes ?? "",
    githubBlobUrl: input.githubBlobUrl ?? null,
    geometrySame: input.geometrySame ?? null,
    requirement: input.requirement ?? null,
    optionGroupId: input.optionGroupId ?? null,
    manifestSource: input.manifestSource ?? null,
    artifactDigest:
      "artifactDigest" in input ? input.artifactDigest ?? null : "a".repeat(64),
  };
}

function draft(parts: readonly PlanDraftPart[]): PlanDraftSnapshot {
  return {
    id: 7,
    profileId: 3,
    baseRevisionId: 11,
    basePlanVersion: 2,
    state: "open",
    lifecycleVersion: 0,
    origin: { kind: "recompute" },
    digestFormat: "plan-draft-v1",
    snapshotDigest: "d".repeat(64),
    createdBy: "test",
    idempotencyKey: "draft",
    createdAt: "2026-08-20T10:00:00.000Z",
    inputs: [
      {
        id: 1,
        draftId: 7,
        sourceId: 5,
        sourceLayer: "source",
        layerOrder: 0,
        trackingKind: "revision",
        sourceRevisionId: 9,
        manifestDigest: "b".repeat(64),
        effectiveNamingDigest: "c".repeat(64),
      },
    ],
    parts: [...parts],
  };
}

function basePart(
  input: Partial<RequiredUnitReconciliationBasePart> &
    Pick<RequiredUnitReconciliationBasePart, "id">,
): RequiredUnitReconciliationBasePart {
  return {
    id: input.id,
    sourceId: input.sourceId ?? 5,
    artifactDigest:
      "artifactDigest" in input ? input.artifactDigest ?? null : "a".repeat(64),
    roleInferred: input.roleInferred ?? "primary",
    roleOverride: input.roleOverride ?? null,
    units:
      input.units ??
      [
        {
          token: `ppu_${input.id.toString(16).padStart(32, "0")}`,
          priorIndex: 0,
          createdAt: "2026-08-20T09:00:00.000Z",
          completed: false,
          assembled: false,
        },
      ],
  };
}

describe("Required-unit reconciliation", () => {
  it("accepts an empty first Plan", () => {
    expect(
      reconcileRequiredUnits({
        draft: { ...draft([]), baseRevisionId: null, basePlanVersion: 0 },
        baseParts: [],
        baseMappingDigest: null,
        decisions: [],
      }),
    ).toEqual({ kind: "ready", assignments: [], surplus: [], selectionBasis: [] });
  });

  it("carries an unchanged predecessor and creates growth slots", () => {
    const result = reconcileRequiredUnits({
      draft: draft([
        draftPart({ id: 21, baseRevisionPartId: 10, quantityEffective: 2 }),
      ]),
      baseParts: [basePart({ id: 10 })],
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    expect(result).toEqual({
      kind: "ready",
      assignments: [
        {
          kind: "reuse",
          draftPartId: 21,
          unitIndex: 0,
          token: "ppu_0000000000000000000000000000000a",
        },
        { kind: "create", draftPartId: 21, unitIndex: 1 },
      ],
      surplus: [],
      selectionBasis: [],
    });
  });

  it("accepts only completed predecessor tokens and creates missing slots", () => {
    const prior = basePart({
      id: 10,
      artifactDigest: "1".repeat(64),
      units: [
        {
          token: "ppu_00000000000000000000000000000001",
          priorIndex: 0,
          createdAt: "2026-08-20T09:00:00.000Z",
          completed: false,
          assembled: false,
        },
        {
          token: "ppu_00000000000000000000000000000002",
          priorIndex: 1,
          createdAt: "2026-08-20T09:01:00.000Z",
          completed: true,
          assembled: false,
        },
      ],
    });
    const target = draftPart({
      id: 21,
      baseRevisionPartId: 10,
      artifactDigest: "2".repeat(64),
      quantityEffective: 2,
    });
    const result = reconcileRequiredUnits({
      draft: draft([target]),
      baseParts: [prior],
      baseMappingDigest: "e".repeat(64),
      decisions: [
        {
          kind: "accept_prior_completion",
          targetDraftPartId: 21,
          predecessorRevisionPartId: 10,
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "ready",
      assignments: [
        {
          kind: "reuse",
          draftPartId: 21,
          unitIndex: 0,
          token: "ppu_00000000000000000000000000000002",
        },
        { kind: "create", draftPartId: 21, unitIndex: 1 },
      ],
      surplus: ["ppu_00000000000000000000000000000001"],
    });
  });

  it("requires a typed decision for unsafe and ambiguous matches", () => {
    const unsafe = reconcileRequiredUnits({
      draft: draft([
        draftPart({
          id: 21,
          baseRevisionPartId: 10,
          artifactDigest: "2".repeat(64),
        }),
      ]),
      baseParts: [basePart({ id: 10, artifactDigest: "1".repeat(64) })],
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    expect(unsafe).toMatchObject({
      kind: "unresolved",
      conflicts: [
        {
          kind: "unsafe_predecessor",
          targetDraftPartId: 21,
          predecessorRevisionPartId: 10,
        },
      ],
    });

    const ambiguous = reconcileRequiredUnits({
      draft: draft([
        draftPart({ id: 21, baseRevisionPartId: null, artifactDigest: "a".repeat(64) }),
      ]),
      baseParts: [basePart({ id: 10 }), basePart({ id: 11 })],
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    expect(ambiguous).toMatchObject({
      kind: "unresolved",
      conflicts: [
        {
          kind: "ambiguous_exact_match",
          targetDraftPartId: 21,
          candidateRevisionPartIds: [10, 11],
        },
      ],
    });
  });

  it("selects completed shrink tokens first and reindexes by prior order", () => {
    const predecessor = basePart({
      id: 10,
      units: [
        {
          token: "ppu_00000000000000000000000000000001",
          priorIndex: 0,
          createdAt: "2026-08-20T09:02:00.000Z",
          completed: false,
          assembled: false,
        },
        {
          token: "ppu_00000000000000000000000000000002",
          priorIndex: 1,
          createdAt: "2026-08-20T09:01:00.000Z",
          completed: true,
          assembled: true,
        },
        {
          token: "ppu_00000000000000000000000000000003",
          priorIndex: 2,
          createdAt: "2026-08-20T09:00:00.000Z",
          completed: true,
          assembled: false,
        },
      ],
    });
    const result = reconcileRequiredUnits({
      draft: draft([
        draftPart({ id: 21, baseRevisionPartId: 10, quantityEffective: 2 }),
      ]),
      baseParts: [predecessor],
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    expect(result).toMatchObject({
      kind: "ready",
      assignments: [
        expect.objectContaining({ unitIndex: 0, token: predecessor.units[1]!.token }),
        expect.objectContaining({ unitIndex: 1, token: predecessor.units[2]!.token }),
      ],
      surplus: [predecessor.units[0]!.token],
      selectionBasis: expect.arrayContaining([
        expect.objectContaining({ token: predecessor.units[0]!.token, completed: false }),
        expect.objectContaining({ token: predecessor.units[1]!.token, assembled: true }),
      ]),
    });
    if (result.kind !== "ready") throw new Error("shrink result was not ready");
    const retained = result.assignments.flatMap((assignment, priorIndex) =>
      assignment.kind === "reuse"
        ? [
            {
              token: assignment.token,
              priorIndex,
              createdAt: `2026-08-20T10:0${priorIndex}:00.000Z`,
              completed: true,
              assembled: false,
            },
          ]
        : [],
    );
    const regrown = reconcileRequiredUnits({
      draft: draft([
        draftPart({ id: 31, baseRevisionPartId: 20, quantityEffective: 3 }),
      ]),
      baseParts: [basePart({ id: 20, units: retained })],
      baseMappingDigest: "f".repeat(64),
      decisions: [],
    });
    expect(regrown).toMatchObject({
      kind: "ready",
      assignments: [
        expect.objectContaining({ kind: "reuse", token: retained[0]!.token }),
        expect.objectContaining({ kind: "reuse", token: retained[1]!.token }),
        { kind: "create", draftPartId: 31, unitIndex: 2 },
      ],
    });
    expect(JSON.stringify(regrown)).not.toContain(predecessor.units[0]!.token);
  });

  it("does not use paths, names, null artifacts, Source changes, or roles as equivalence", () => {
    const changed = draftPart({
      id: 21,
      baseRevisionPartId: 10,
      partKey: "same",
      filename: "same.stl",
      artifactDigest: null,
    });
    const predecessor = basePart({ id: 10, artifactDigest: null });
    expect(
      reconcileRequiredUnits({
        draft: draft([changed]),
        baseParts: [predecessor],
        baseMappingDigest: "e".repeat(64),
        decisions: [],
      }),
    ).toMatchObject({ kind: "unresolved", conflicts: [{ kind: "unsafe_predecessor" }] });

    for (const candidate of [
      basePart({ id: 10, sourceId: 99 }),
      basePart({ id: 10, roleOverride: "accent" }),
      basePart({ id: 10, artifactDigest: "2".repeat(64) }),
    ]) {
      expect(
        reconcileRequiredUnits({
          draft: draft([draftPart({ id: 21, baseRevisionPartId: null })]),
          baseParts: [candidate],
          baseMappingDigest: "e".repeat(64),
          decisions: [],
        }),
      ).toMatchObject({
        kind: "ready",
        assignments: [{ kind: "create", draftPartId: 21, unitIndex: 0 }],
      });
    }
  });

  it("validates exact candidates and predecessor claims", () => {
    const ambiguousDraft = draft([
      draftPart({ id: 21, baseRevisionPartId: null }),
      draftPart({ id: 22, baseRevisionPartId: null }),
    ]);
    const predecessors = [basePart({ id: 10 }), basePart({ id: 11 })];
    expect(() =>
      reconcileRequiredUnits({
        draft: ambiguousDraft,
        baseParts: predecessors,
        baseMappingDigest: "e".repeat(64),
        decisions: [
          {
            kind: "select_exact_predecessor",
            targetDraftPartId: 21,
            predecessorRevisionPartId: 99,
          },
        ],
      }),
    ).toThrow(/candidate/i);
    expect(() =>
      reconcileRequiredUnits({
        draft: ambiguousDraft,
        baseParts: predecessors,
        baseMappingDigest: "e".repeat(64),
        decisions: [
          {
            kind: "select_exact_predecessor",
            targetDraftPartId: 21,
            predecessorRevisionPartId: 10,
          },
          {
            kind: "select_exact_predecessor",
            targetDraftPartId: 22,
            predecessorRevisionPartId: 10,
          },
        ],
      }),
    ).toThrow(/already selected/i);
  });

  it("keeps exclusion identity and derives removed tokens as surplus deterministically", () => {
    const excluded = draftPart({
      id: 21,
      baseRevisionPartId: 10,
      included: false,
    });
    const base = [basePart({ id: 10 }), basePart({ id: 11 })];
    const left = reconcileRequiredUnits({
      draft: draft([excluded]),
      baseParts: base,
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    const right = reconcileRequiredUnits({
      draft: draft([excluded]),
      baseParts: [...base].reverse(),
      baseMappingDigest: "e".repeat(64),
      decisions: [],
    });
    expect(right).toEqual(left);
    expect(left).toMatchObject({
      kind: "ready",
      assignments: [expect.objectContaining({ token: base[0]!.units[0]!.token })],
      surplus: [base[1]!.units[0]!.token],
    });
  });

  it("rejects invalid quantities and assembled without completion", () => {
    expect(() =>
      reconcileRequiredUnits({
        draft: draft([draftPart({ id: 21, quantityEffective: 10_001 })]),
        baseParts: [],
        baseMappingDigest: null,
        decisions: [],
      }),
    ).toThrow(/quantity/i);
    expect(() =>
      reconcileRequiredUnits({
        draft: draft([draftPart({ id: 21, baseRevisionPartId: 10 })]),
        baseParts: [
          basePart({
            id: 10,
            units: [
              {
                token: "ppu_00000000000000000000000000000001",
                priorIndex: 0,
                createdAt: "2026-08-20T09:00:00.000Z",
                completed: false,
                assembled: true,
              },
            ],
          }),
        ],
        baseMappingDigest: "e".repeat(64),
        decisions: [],
      }),
    ).toThrow(/progress/i);
  });

  it("excludes extra runtime decision properties from the canonical digest", () => {
    const replaceWithExtras = {
      kind: "replace" as const,
      targetDraftPartId: 21,
      predecessorRevisionPartId: 10,
      ignored: "value",
    };
    const selectWithExtras = {
      kind: "select_exact_predecessor" as const,
      targetDraftPartId: 22,
      predecessorRevisionPartId: 11,
      ignored: "value",
    };
    expect(digestRequiredUnitDecisions([replaceWithExtras, selectWithExtras])).toBe(
      digestRequiredUnitDecisions([
        { kind: "replace", targetDraftPartId: 21 },
        {
          kind: "select_exact_predecessor",
          targetDraftPartId: 22,
          predecessorRevisionPartId: 11,
        },
      ]),
    );
  });
});
