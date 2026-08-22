import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";

export const REQUIRED_UNIT_MAP_FORMAT = "required-unit-map-v1";
export const MAX_REQUIRED_UNIT_OBJECT_NAME_LENGTH = 200;
export const MAX_REQUIRED_UNIT_INDEX = 9_999;

declare const requiredUnitTokenBrand: unique symbol;

export type RequiredUnitToken = string & {
  readonly [requiredUnitTokenBrand]: true;
};

export type RequiredUnitDigestRow = {
  readonly revisionPartId: number;
  readonly unitIndex: number;
  readonly token: string;
  readonly objectName: string;
};

const REQUIRED_UNIT_TOKEN_PATTERN = /^ppu_[0-9a-f]{32}$/;
const REQUIRED_UNIT_OBJECT_NAME_PATTERN = /^[A-Za-z0-9_ .()+-]+$/;
const INVALID_OBJECT_STEM_CHARACTERS = /[^A-Za-z0-9_ .()+-]/g;

export function parseRequiredUnitToken(value: string): RequiredUnitToken {
  if (!REQUIRED_UNIT_TOKEN_PATTERN.test(value)) {
    throw new Error("Required-unit token is invalid");
  }
  return value as RequiredUnitToken;
}

export function generateRequiredUnitToken(
  generateBytes: (size: number) => Uint8Array = randomBytes,
): RequiredUnitToken {
  const bytes = generateBytes(16);
  if (bytes.length !== 16) throw new Error("Required-unit token entropy is invalid");
  return parseRequiredUnitToken(`ppu_${Buffer.from(bytes).toString("hex")}`);
}

export function requiredUnitObjectName(filename: string, tokenValue: string): string {
  const token = parseRequiredUnitToken(tokenValue);
  const base = basename(filename);
  const withoutSuffix = base.replace(/\.stl$/i, "");
  const sanitized = withoutSuffix.replace(INVALID_OBJECT_STEM_CHARACTERS, "_") || "part";
  const suffix = `__${token}`;
  return `${sanitized.slice(0, MAX_REQUIRED_UNIT_OBJECT_NAME_LENGTH - suffix.length)}${suffix}`;
}

export function validateRequiredUnitObjectName(
  objectName: string,
  tokenValue: string,
): void {
  const token = parseRequiredUnitToken(tokenValue);
  if (
    objectName.length === 0 ||
    objectName.length > MAX_REQUIRED_UNIT_OBJECT_NAME_LENGTH ||
    !REQUIRED_UNIT_OBJECT_NAME_PATTERN.test(objectName) ||
    !objectName.endsWith(`__${token}`)
  ) {
    throw new Error("Required-unit Object name is invalid");
  }
}

function validatedDigestRows(rows: readonly RequiredUnitDigestRow[]): RequiredUnitDigestRow[] {
  return rows
    .map((row) => {
      if (!Number.isSafeInteger(row.revisionPartId) || row.revisionPartId <= 0) {
        throw new Error("Required-unit revision Part ID is invalid");
      }
      if (
        !Number.isSafeInteger(row.unitIndex) ||
        row.unitIndex < 0 ||
        row.unitIndex > MAX_REQUIRED_UNIT_INDEX
      ) {
        throw new Error("Required-unit index is invalid");
      }
      parseRequiredUnitToken(row.token);
      validateRequiredUnitObjectName(row.objectName, row.token);
      return { ...row };
    })
    .sort(
      (left, right) =>
        left.revisionPartId - right.revisionPartId || left.unitIndex - right.unitIndex,
    );
}

export function digestRequiredUnitMap(input: {
  readonly revisionId: number;
  readonly expectedUnitCount: number;
  readonly rows: readonly RequiredUnitDigestRow[];
}): string {
  if (!Number.isSafeInteger(input.revisionId) || input.revisionId <= 0) {
    throw new Error("Required-unit revision ID is invalid");
  }
  if (!Number.isSafeInteger(input.expectedUnitCount) || input.expectedUnitCount < 0) {
    throw new Error("Required-unit expected count is invalid");
  }
  const rows = validatedDigestRows(input.rows).map((row) => ({
    revision_part_id: row.revisionPartId,
    unit_index: row.unitIndex,
    token: row.token,
    object_name: row.objectName,
  }));
  const canonical = JSON.stringify({
    format: REQUIRED_UNIT_MAP_FORMAT,
    revision_id: input.revisionId,
    expected_unit_count: input.expectedUnitCount,
    rows,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
