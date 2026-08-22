import { createHash } from "node:crypto";
import {
  MAX_PLAN_DRAFT_PART_QUANTITY,
  type PlanDraftPart,
  type PlanDraftSnapshot,
} from "./plan-drafts.js";
import { parseRequiredUnitToken } from "./required-units.js";

export const REQUIRED_UNIT_RECONCILIATION_FORMAT = "required-unit-reconciliation-v1";

export type RequiredUnitReconciliationUnit = {
  readonly token: string;
  readonly priorIndex: number;
  readonly createdAt: string;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type RequiredUnitReconciliationBasePart = {
  readonly id: number;
  readonly sourceId: number | null;
  readonly artifactDigest: string | null;
  readonly roleInferred: string;
  readonly roleOverride: string | null;
  readonly units: readonly RequiredUnitReconciliationUnit[];
};

export type RequiredUnitReconciliationDecision =
  | {
      readonly kind: "select_exact_predecessor";
      readonly targetDraftPartId: number;
      readonly predecessorRevisionPartId: number;
    }
  | {
      readonly kind: "accept_prior_completion";
      readonly targetDraftPartId: number;
      readonly predecessorRevisionPartId: number;
    }
  | {
      readonly kind: "replace";
      readonly targetDraftPartId: number;
    };

export type RequiredUnitReconciliationConflict =
  | {
      readonly kind: "unsafe_predecessor";
      readonly targetDraftPartId: number;
      readonly predecessorRevisionPartId: number;
    }
  | {
      readonly kind: "ambiguous_exact_match";
      readonly targetDraftPartId: number;
      readonly candidateRevisionPartIds: readonly number[];
    }
  | {
      readonly kind: "predecessor_claimed";
      readonly targetDraftPartId: number;
      readonly predecessorRevisionPartId: number;
    };

export type RequiredUnitAssignment =
  | {
      readonly kind: "reuse";
      readonly draftPartId: number;
      readonly unitIndex: number;
      readonly token: string;
    }
  | {
      readonly kind: "create";
      readonly draftPartId: number;
      readonly unitIndex: number;
    };

export type RequiredUnitSelectionBasisRow = {
  readonly revisionPartId: number;
  readonly token: string;
  readonly priorIndex: number;
  readonly createdAt: string;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type RequiredUnitReconciliationResult =
  | {
      readonly kind: "unresolved";
      readonly conflicts: readonly RequiredUnitReconciliationConflict[];
      readonly selectionBasis: readonly RequiredUnitSelectionBasisRow[];
    }
  | {
      readonly kind: "ready";
      readonly assignments: readonly RequiredUnitAssignment[];
      readonly surplus: readonly string[];
      readonly selectionBasis: readonly RequiredUnitSelectionBasisRow[];
    };

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} is invalid`);
  }
}

function positiveId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function unitIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_PLAN_DRAFT_PART_QUANTITY) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function parsedJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function canonicalSelectionBasisRows(
  rows: readonly RequiredUnitSelectionBasisRow[],
): RequiredUnitSelectionBasisRow[] {
  const seen = new Set<string>();
  const tokens = new Set<string>();
  return [...rows]
    .map((row) => {
      const revisionPartId = positiveId(row.revisionPartId, "Required-unit basis Part ID");
      const priorIndex = unitIndex(row.priorIndex, "Required-unit basis index");
      const token = parseRequiredUnitToken(row.token);
      if (typeof row.createdAt !== "string" || row.createdAt.length === 0) {
        throw new Error("Required-unit basis creation time is invalid");
      }
      if (typeof row.completed !== "boolean" || typeof row.assembled !== "boolean") {
        throw new Error("Required-unit basis progress is invalid");
      }
      if (row.assembled && !row.completed) {
        throw new Error("Required-unit basis progress is corrupt");
      }
      const key = `${revisionPartId}:${priorIndex}`;
      if (seen.has(key) || tokens.has(token)) {
        throw new Error("Required-unit basis row is duplicated");
      }
      seen.add(key);
      tokens.add(token);
      return {
        revisionPartId,
        token,
        priorIndex,
        createdAt: row.createdAt,
        completed: row.completed,
        assembled: row.assembled,
      };
    })
    .sort(
      (left, right) =>
        left.revisionPartId - right.revisionPartId || left.priorIndex - right.priorIndex,
    );
}

export function serializeRequiredUnitSelectionBasis(
  rows: readonly RequiredUnitSelectionBasisRow[],
): string {
  return JSON.stringify(canonicalSelectionBasisRows(rows));
}

export function parseRequiredUnitSelectionBasis(
  value: string,
): readonly RequiredUnitSelectionBasisRow[] {
  const parsed = parsedJson(value, "Required-unit selection basis");
  if (!Array.isArray(parsed)) throw new Error("Required-unit selection basis is invalid");
  const rows = parsed.map((item): RequiredUnitSelectionBasisRow => {
    const row = jsonRecord(item, "Required-unit selection basis row");
    exactKeys(
      row,
      ["revisionPartId", "token", "priorIndex", "createdAt", "completed", "assembled"],
      "Required-unit selection basis row",
    );
    return {
      revisionPartId: positiveId(row.revisionPartId, "Required-unit basis Part ID"),
      token: typeof row.token === "string" ? row.token : "",
      priorIndex: unitIndex(row.priorIndex, "Required-unit basis index"),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      completed: row.completed as boolean,
      assembled: row.assembled as boolean,
    };
  });
  const canonical = canonicalSelectionBasisRows(rows);
  if (JSON.stringify(canonical) !== value) {
    throw new Error("Required-unit selection basis is not canonical");
  }
  return canonical;
}

function canonicalAssignments(
  assignments: readonly RequiredUnitAssignment[],
): RequiredUnitAssignment[] {
  const slots = new Set<string>();
  const tokens = new Set<string>();
  return [...assignments]
    .map((assignment): RequiredUnitAssignment => {
      const draftPartId = positiveId(assignment.draftPartId, "Required-unit assignment Part ID");
      const index = unitIndex(assignment.unitIndex, "Required-unit assignment index");
      const slot = `${draftPartId}:${index}`;
      if (slots.has(slot)) throw new Error("Required-unit assignment slot is duplicated");
      slots.add(slot);
      if (assignment.kind === "create") {
        return { kind: "create", draftPartId, unitIndex: index };
      }
      const token = parseRequiredUnitToken(assignment.token);
      if (tokens.has(token)) throw new Error("Required-unit assignment token is duplicated");
      tokens.add(token);
      return { kind: "reuse", draftPartId, unitIndex: index, token };
    })
    .sort(
      (left, right) =>
        left.draftPartId - right.draftPartId || left.unitIndex - right.unitIndex,
    );
}

function canonicalConflicts(
  conflicts: readonly RequiredUnitReconciliationConflict[],
): RequiredUnitReconciliationConflict[] {
  const targets = new Set<number>();
  return [...conflicts]
    .map((conflict): RequiredUnitReconciliationConflict => {
      const targetDraftPartId = positiveId(
        conflict.targetDraftPartId,
        "Required-unit conflict target",
      );
      if (targets.has(targetDraftPartId)) {
        throw new Error("Required-unit conflict target is duplicated");
      }
      targets.add(targetDraftPartId);
      if (conflict.kind === "ambiguous_exact_match") {
        const candidates = conflict.candidateRevisionPartIds.map((candidate) =>
          positiveId(candidate, "Required-unit conflict candidate"),
        );
        const canonical = [...new Set(candidates)].sort((left, right) => left - right);
        if (canonical.length !== candidates.length || canonical.length === 0) {
          throw new Error("Required-unit conflict candidates are invalid");
        }
        return {
          kind: "ambiguous_exact_match",
          targetDraftPartId,
          candidateRevisionPartIds: canonical,
        };
      }
      return {
        kind: conflict.kind,
        targetDraftPartId,
        predecessorRevisionPartId: positiveId(
          conflict.predecessorRevisionPartId,
          "Required-unit conflict predecessor",
        ),
      };
    })
    .sort(
      (left, right) =>
        left.targetDraftPartId - right.targetDraftPartId || left.kind.localeCompare(right.kind),
    );
}

export function serializeRequiredUnitReconciliationResult(
  result: RequiredUnitReconciliationResult,
): string {
  if (result.kind === "unresolved") {
    return JSON.stringify({ kind: "unresolved", conflicts: canonicalConflicts(result.conflicts) });
  }
  const assignments = canonicalAssignments(result.assignments);
  const surplus = [...result.surplus].map(parseRequiredUnitToken).sort();
  const reused = new Set(
    assignments.flatMap((assignment) => (assignment.kind === "reuse" ? [assignment.token] : [])),
  );
  if (new Set(surplus).size !== surplus.length || surplus.some((token) => reused.has(token))) {
    throw new Error("Required-unit reconciliation surplus is duplicated");
  }
  return JSON.stringify({
    kind: "ready",
    assignments,
    surplus,
  });
}

export function parseRequiredUnitReconciliationResult(input: {
  readonly resultJson: string;
  readonly selectionBasis: readonly RequiredUnitSelectionBasisRow[];
}): RequiredUnitReconciliationResult {
  const parsed = jsonRecord(
    parsedJson(input.resultJson, "Required-unit reconciliation result"),
    "Required-unit reconciliation result",
  );
  if (parsed.kind === "unresolved") {
    exactKeys(parsed, ["kind", "conflicts"], "Required-unit reconciliation result");
    if (!Array.isArray(parsed.conflicts)) {
      throw new Error("Required-unit reconciliation conflicts are invalid");
    }
    const conflicts = parsed.conflicts.map((item): RequiredUnitReconciliationConflict => {
      const conflict = jsonRecord(item, "Required-unit reconciliation conflict");
      if (conflict.kind === "ambiguous_exact_match") {
        exactKeys(
          conflict,
          ["kind", "targetDraftPartId", "candidateRevisionPartIds"],
          "Required-unit reconciliation conflict",
        );
        if (!Array.isArray(conflict.candidateRevisionPartIds)) {
          throw new Error("Required-unit reconciliation candidates are invalid");
        }
        return {
          kind: "ambiguous_exact_match",
          targetDraftPartId: positiveId(conflict.targetDraftPartId, "Required-unit conflict target"),
          candidateRevisionPartIds: conflict.candidateRevisionPartIds.map((candidate) =>
            positiveId(candidate, "Required-unit conflict candidate"),
          ),
        };
      }
      if (conflict.kind !== "unsafe_predecessor" && conflict.kind !== "predecessor_claimed") {
        throw new Error("Required-unit reconciliation conflict kind is invalid");
      }
      exactKeys(
        conflict,
        ["kind", "targetDraftPartId", "predecessorRevisionPartId"],
        "Required-unit reconciliation conflict",
      );
      return {
        kind: conflict.kind,
        targetDraftPartId: positiveId(conflict.targetDraftPartId, "Required-unit conflict target"),
        predecessorRevisionPartId: positiveId(
          conflict.predecessorRevisionPartId,
          "Required-unit conflict predecessor",
        ),
      };
    });
    const result: RequiredUnitReconciliationResult = {
      kind: "unresolved",
      conflicts: canonicalConflicts(conflicts),
      selectionBasis: canonicalSelectionBasisRows(input.selectionBasis),
    };
    if (serializeRequiredUnitReconciliationResult(result) !== input.resultJson) {
      throw new Error("Required-unit reconciliation result is not canonical");
    }
    return result;
  }
  if (parsed.kind !== "ready") throw new Error("Required-unit reconciliation kind is invalid");
  exactKeys(parsed, ["kind", "assignments", "surplus"], "Required-unit reconciliation result");
  if (!Array.isArray(parsed.assignments) || !Array.isArray(parsed.surplus)) {
    throw new Error("Required-unit reconciliation ready result is invalid");
  }
  const assignments = parsed.assignments.map((item): RequiredUnitAssignment => {
    const assignment = jsonRecord(item, "Required-unit assignment");
    if (assignment.kind === "create") {
      exactKeys(assignment, ["kind", "draftPartId", "unitIndex"], "Required-unit assignment");
      return {
        kind: "create",
        draftPartId: positiveId(assignment.draftPartId, "Required-unit assignment Part ID"),
        unitIndex: unitIndex(assignment.unitIndex, "Required-unit assignment index"),
      };
    }
    if (assignment.kind !== "reuse") throw new Error("Required-unit assignment kind is invalid");
    exactKeys(
      assignment,
      ["kind", "draftPartId", "unitIndex", "token"],
      "Required-unit assignment",
    );
    if (typeof assignment.token !== "string") throw new Error("Required-unit token is invalid");
    return {
      kind: "reuse",
      draftPartId: positiveId(assignment.draftPartId, "Required-unit assignment Part ID"),
      unitIndex: unitIndex(assignment.unitIndex, "Required-unit assignment index"),
      token: assignment.token,
    };
  });
  if (parsed.surplus.some((token) => typeof token !== "string")) {
    throw new Error("Required-unit reconciliation surplus is invalid");
  }
  const result: RequiredUnitReconciliationResult = {
    kind: "ready",
    assignments: canonicalAssignments(assignments),
    surplus: (parsed.surplus as string[]).map(parseRequiredUnitToken).sort(),
    selectionBasis: canonicalSelectionBasisRows(input.selectionBasis),
  };
  if (serializeRequiredUnitReconciliationResult(result) !== input.resultJson) {
    throw new Error("Required-unit reconciliation result is not canonical");
  }
  return result;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function effectiveRole(part: {
  readonly roleInferred: string;
  readonly roleOverride: string | null;
}): string {
  return part.roleOverride ?? part.roleInferred;
}

function sourceIdByLayer(draft: PlanDraftSnapshot): ReadonlyMap<string, number | null> {
  const result = new Map<string, number | null>();
  for (const input of draft.inputs) {
    result.set(input.sourceLayer, result.has(input.sourceLayer) ? null : input.sourceId);
  }
  return result;
}

function exactMatch(
  target: PlanDraftPart,
  targetSourceId: number | null | undefined,
  predecessor: RequiredUnitReconciliationBasePart,
): boolean {
  return (
    targetSourceId != null &&
    predecessor.sourceId === targetSourceId &&
    target.artifactDigest != null &&
    predecessor.artifactDigest === target.artifactDigest &&
    effectiveRole(target) === effectiveRole(predecessor)
  );
}

function validateUnit(unit: RequiredUnitReconciliationUnit): void {
  parseRequiredUnitToken(unit.token);
  if (!Number.isSafeInteger(unit.priorIndex) || unit.priorIndex < 0) {
    throw new Error("Required-unit predecessor index is invalid");
  }
  if (unit.assembled && !unit.completed) {
    throw new Error("Required-unit predecessor progress is corrupt");
  }
}

function validatedBaseParts(
  parts: readonly RequiredUnitReconciliationBasePart[],
): RequiredUnitReconciliationBasePart[] {
  const ids = new Set<number>();
  const tokens = new Set<string>();
  return [...parts]
    .map((part) => {
      if (!Number.isSafeInteger(part.id) || part.id <= 0 || ids.has(part.id)) {
        throw new Error("Required-unit predecessor Part ID is invalid");
      }
      ids.add(part.id);
      const units = [...part.units].sort((left, right) => left.priorIndex - right.priorIndex);
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        if (!unit) throw new Error("Required-unit predecessor unit is missing");
        validateUnit(unit);
        if (unit.priorIndex !== index || tokens.has(unit.token)) {
          throw new Error("Required-unit predecessor mapping is invalid");
        }
        tokens.add(unit.token);
      }
      return { ...part, units };
    })
    .sort((left, right) => left.id - right.id);
}

function validatedDraftParts(parts: readonly PlanDraftPart[]): PlanDraftPart[] {
  const ids = new Set<number>();
  return [...parts]
    .map((part) => {
      if (!Number.isSafeInteger(part.id) || part.id <= 0 || ids.has(part.id)) {
        throw new Error("Required-unit target Part ID is invalid");
      }
      if (
        !Number.isSafeInteger(part.quantityEffective) ||
        part.quantityEffective < 1 ||
        part.quantityEffective > MAX_PLAN_DRAFT_PART_QUANTITY
      ) {
        throw new Error("Required-unit target quantity is invalid");
      }
      ids.add(part.id);
      return part;
    })
    .sort((left, right) => left.id - right.id);
}

function canonicalDecisions(
  decisions: readonly RequiredUnitReconciliationDecision[],
): RequiredUnitReconciliationDecision[] {
  const targets = new Set<number>();
  const predecessors = new Set<number>();
  return [...decisions]
    .map((decision): RequiredUnitReconciliationDecision => {
      if (
        !Number.isSafeInteger(decision.targetDraftPartId) ||
        decision.targetDraftPartId <= 0 ||
        targets.has(decision.targetDraftPartId)
      ) {
        throw new Error("Required-unit reconciliation decision target is invalid");
      }
      targets.add(decision.targetDraftPartId);
      if (
        decision.kind !== "replace" &&
        (!Number.isSafeInteger(decision.predecessorRevisionPartId) ||
          decision.predecessorRevisionPartId <= 0)
      ) {
        throw new Error("Required-unit reconciliation predecessor is invalid");
      }
      if (decision.kind !== "replace") {
        if (predecessors.has(decision.predecessorRevisionPartId)) {
          throw new Error("Required-unit reconciliation predecessor is already selected");
        }
        predecessors.add(decision.predecessorRevisionPartId);
        return {
          kind: decision.kind,
          targetDraftPartId: decision.targetDraftPartId,
          predecessorRevisionPartId: decision.predecessorRevisionPartId,
        };
      }
      return { kind: "replace", targetDraftPartId: decision.targetDraftPartId };
    })
    .sort((left, right) => left.targetDraftPartId - right.targetDraftPartId);
}

function basisRows(
  part: RequiredUnitReconciliationBasePart,
): RequiredUnitSelectionBasisRow[] {
  return part.units.map((unit) => ({
    revisionPartId: part.id,
    token: unit.token,
    priorIndex: unit.priorIndex,
    createdAt: unit.createdAt,
    completed: unit.completed,
    assembled: unit.assembled,
  }));
}

function compareSelection(left: RequiredUnitReconciliationUnit, right: RequiredUnitReconciliationUnit): number {
  if (left.completed !== right.completed) return left.completed ? -1 : 1;
  return left.createdAt.localeCompare(right.createdAt) || left.token.localeCompare(right.token);
}

function normalAssignments(input: {
  readonly target: PlanDraftPart;
  readonly predecessor: RequiredUnitReconciliationBasePart;
}): {
  readonly assignments: RequiredUnitAssignment[];
  readonly selectedTokens: ReadonlySet<string>;
  readonly selectionBasis: RequiredUnitSelectionBasisRow[];
} {
  const count = input.target.quantityEffective;
  const source = input.predecessor.units;
  const selected =
    count < source.length
      ? [...source].sort(compareSelection).slice(0, count)
      : [...source];
  const ordered = selected.sort((left, right) => left.priorIndex - right.priorIndex);
  const assignments: RequiredUnitAssignment[] = ordered.map((unit, unitIndex) => ({
    kind: "reuse",
    draftPartId: input.target.id,
    unitIndex,
    token: unit.token,
  }));
  for (let unitIndex = assignments.length; unitIndex < count; unitIndex += 1) {
    assignments.push({ kind: "create", draftPartId: input.target.id, unitIndex });
  }
  return {
    assignments,
    selectedTokens: new Set(ordered.map((unit) => unit.token)),
    selectionBasis: count < source.length ? basisRows(input.predecessor) : [],
  };
}

function acceptedCompletionAssignments(input: {
  readonly target: PlanDraftPart;
  readonly predecessor: RequiredUnitReconciliationBasePart;
}): {
  readonly assignments: RequiredUnitAssignment[];
  readonly selectedTokens: ReadonlySet<string>;
  readonly selectionBasis: RequiredUnitSelectionBasisRow[];
} {
  const completed = input.predecessor.units
    .filter((unit) => unit.completed)
    .sort(compareSelection)
    .slice(0, input.target.quantityEffective)
    .sort((left, right) => left.priorIndex - right.priorIndex);
  const assignments: RequiredUnitAssignment[] = completed.map((unit, unitIndex) => ({
    kind: "reuse",
    draftPartId: input.target.id,
    unitIndex,
    token: unit.token,
  }));
  for (
    let unitIndex = assignments.length;
    unitIndex < input.target.quantityEffective;
    unitIndex += 1
  ) {
    assignments.push({ kind: "create", draftPartId: input.target.id, unitIndex });
  }
  return {
    assignments,
    selectedTokens: new Set(completed.map((unit) => unit.token)),
    selectionBasis: basisRows(input.predecessor),
  };
}

export function reconcileRequiredUnits(input: {
  readonly draft: PlanDraftSnapshot;
  readonly baseParts: readonly RequiredUnitReconciliationBasePart[];
  readonly baseMappingDigest: string | null;
  readonly decisions: readonly RequiredUnitReconciliationDecision[];
}): RequiredUnitReconciliationResult {
  const targets = validatedDraftParts(input.draft.parts);
  const baseParts = validatedBaseParts(input.baseParts);
  const baseById = new Map(baseParts.map((part) => [part.id, part]));
  const targetsById = new Map(targets.map((part) => [part.id, part]));
  const decisions = canonicalDecisions(input.decisions);
  const decisionByTarget = new Map(decisions.map((decision) => [decision.targetDraftPartId, decision]));
  for (const decision of decisions) {
    if (!targetsById.has(decision.targetDraftPartId)) {
      throw new Error("Required-unit reconciliation decision target is missing");
    }
  }
  const sources = sourceIdByLayer(input.draft);
  const candidatesByTarget = new Map<number, RequiredUnitReconciliationBasePart[]>();
  const targetCountByBase = new Map<number, number>();
  for (const target of targets) {
    const candidates = baseParts.filter((base) =>
      exactMatch(target, sources.get(target.sourceLayer), base),
    );
    candidatesByTarget.set(target.id, candidates);
    for (const candidate of candidates) {
      targetCountByBase.set(candidate.id, (targetCountByBase.get(candidate.id) ?? 0) + 1);
    }
  }

  const predecessorByTarget = new Map<number, RequiredUnitReconciliationBasePart | null>();
  const modeByTarget = new Map<number, "normal" | "accept" | "replace" | "create">();
  const conflicts: RequiredUnitReconciliationConflict[] = [];
  const claimed = new Map<number, number>();
  for (const target of targets) {
    const decision = decisionByTarget.get(target.id);
    const known =
      target.baseRevisionPartId == null
        ? null
        : baseById.get(target.baseRevisionPartId) ?? null;
    const candidates = candidatesByTarget.get(target.id) ?? [];
    const safeKnown =
      known != null && exactMatch(target, sources.get(target.sourceLayer), known);
    let predecessor: RequiredUnitReconciliationBasePart | null = null;
    let mode: "normal" | "accept" | "replace" | "create";

    if (known) {
      if (safeKnown) {
        if (decision) throw new Error("Required-unit reconciliation decision is not applicable");
        predecessor = known;
        mode = "normal";
      } else if (!decision) {
        conflicts.push({
          kind: "unsafe_predecessor",
          targetDraftPartId: target.id,
          predecessorRevisionPartId: known.id,
        });
        continue;
      } else if (decision.kind === "accept_prior_completion") {
        if (decision.predecessorRevisionPartId !== known.id) {
          throw new Error("Accepted prior completion predecessor is not the known predecessor");
        }
        predecessor = known;
        mode = "accept";
      } else if (decision.kind === "replace") {
        mode = "replace";
      } else {
        throw new Error("Exact predecessor selection is not applicable to an unsafe predecessor");
      }
    } else {
      const unique =
        candidates.length === 1 && targetCountByBase.get(candidates[0]!.id) === 1
          ? candidates[0]!
          : null;
      if (unique) {
        if (decision) throw new Error("Required-unit reconciliation decision is not applicable");
        predecessor = unique;
        mode = "normal";
      } else if (candidates.length > 0) {
        if (!decision) {
          conflicts.push({
            kind: "ambiguous_exact_match",
            targetDraftPartId: target.id,
            candidateRevisionPartIds: candidates.map((part) => part.id).sort((a, b) => a - b),
          });
          continue;
        }
        if (decision.kind === "select_exact_predecessor") {
          const selected = candidates.find(
            (candidate) => candidate.id === decision.predecessorRevisionPartId,
          );
          if (!selected) throw new Error("Selected predecessor is not an exact-match candidate");
          predecessor = selected;
          mode = "normal";
        } else if (decision.kind === "replace") {
          mode = "replace";
        } else {
          throw new Error("Prior completion requires a known unsafe predecessor");
        }
      } else {
        if (decision) throw new Error("Required-unit reconciliation decision is not applicable");
        mode = "create";
      }
    }
    if (predecessor) {
      const priorClaim = claimed.get(predecessor.id);
      if (priorClaim != null) {
        conflicts.push({
          kind: "predecessor_claimed",
          targetDraftPartId: target.id,
          predecessorRevisionPartId: predecessor.id,
        });
        continue;
      }
      claimed.set(predecessor.id, target.id);
    }
    predecessorByTarget.set(target.id, predecessor);
    modeByTarget.set(target.id, mode);
  }
  if (conflicts.length > 0) {
    return {
      kind: "unresolved",
      conflicts: conflicts.sort(
        (left, right) =>
          left.targetDraftPartId - right.targetDraftPartId || left.kind.localeCompare(right.kind),
      ),
      selectionBasis: [],
    };
  }

  const assignments: RequiredUnitAssignment[] = [];
  const selectionBasis: RequiredUnitSelectionBasisRow[] = [];
  const selectedTokens = new Set<string>();
  for (const target of targets) {
    const mode = modeByTarget.get(target.id);
    const predecessor = predecessorByTarget.get(target.id) ?? null;
    if (mode === "normal" && predecessor) {
      const result = normalAssignments({ target, predecessor });
      assignments.push(...result.assignments);
      selectionBasis.push(...result.selectionBasis);
      for (const token of result.selectedTokens) selectedTokens.add(token);
    } else if (mode === "accept" && predecessor) {
      const result = acceptedCompletionAssignments({ target, predecessor });
      assignments.push(...result.assignments);
      selectionBasis.push(...result.selectionBasis);
      for (const token of result.selectedTokens) selectedTokens.add(token);
    } else {
      for (let unitIndex = 0; unitIndex < target.quantityEffective; unitIndex += 1) {
        assignments.push({ kind: "create", draftPartId: target.id, unitIndex });
      }
    }
  }
  const surplus = baseParts
    .flatMap((part) => part.units.map((unit) => unit.token))
    .filter((token) => !selectedTokens.has(token))
    .sort();
  return {
    kind: "ready",
    assignments,
    surplus,
    selectionBasis: selectionBasis.sort(
      (left, right) =>
        left.revisionPartId - right.revisionPartId || left.priorIndex - right.priorIndex,
    ),
  };
}

export function digestRequiredUnitDecisions(
  decisions: readonly RequiredUnitReconciliationDecision[],
): string {
  return sha256(canonicalDecisions(decisions));
}

export function digestRequiredUnitSelectionBasis(input: {
  readonly baseMappingDigest: string | null;
  readonly rows: readonly RequiredUnitSelectionBasisRow[];
}): string {
  return sha256({
    format: REQUIRED_UNIT_RECONCILIATION_FORMAT,
    base_mapping_digest: input.baseMappingDigest,
    rows: [...input.rows].sort(
      (left, right) =>
        left.revisionPartId - right.revisionPartId || left.priorIndex - right.priorIndex,
    ),
  });
}

export function digestRequiredUnitReconciliationResult(
  result: RequiredUnitReconciliationResult,
): string {
  return sha256(result);
}

export function digestRequiredUnitReconciliation(input: {
  readonly baseRevisionId: number | null;
  readonly baseMappingDigest: string | null;
  readonly planningDigest: string;
  readonly selectionBasisDigest: string;
  readonly decisionDigest: string;
  readonly resultKind: "unresolved" | "ready";
  readonly resultDigest: string;
}): string {
  return sha256({
    format: REQUIRED_UNIT_RECONCILIATION_FORMAT,
    base_revision_id: input.baseRevisionId,
    base_mapping_digest: input.baseMappingDigest,
    planning_digest: input.planningDigest,
    selection_basis_digest: input.selectionBasisDigest,
    decision_digest: input.decisionDigest,
    result_kind: input.resultKind,
    result_digest: input.resultDigest,
  });
}
