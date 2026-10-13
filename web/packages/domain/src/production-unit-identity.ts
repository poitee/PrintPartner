import { interpretSlicedObjectName } from "./sliced-object-matching.js";

const REQUIRED_UNIT_TOKEN_IN_OBJECT_NAME = /__(ppu_[0-9a-f]{32})$/;

export type RecordedPrintIdentity = Readonly<{
  profileId: number;
  state: string;
  objectNames: readonly (string | null | undefined)[];
}>;

export type CurrentPackageDispatchCoverage = "none" | "partial" | "full";

/**
 * Required-unit tokens carried in object names. A bare filename contributes none.
 *
 * Printer send stores the slicer's raw label, so Orca `_id_0_copy_0`, Prusa
 * `_instance_N`, and ` (instance N)` sit after the canonical name. Those
 * suffixes are removed by the same object-name parser the slicer matcher
 * uses. The token then has to end that canonical name. Searching the raw
 * label for `ppu_` would also accept a token that is only part of a longer
 * name.
 */
export function requiredUnitTokensInObjectNames(
  names: readonly (string | null | undefined)[],
): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const canonical = interpretSlicedObjectName(name).unwrappedName;
    const match = REQUIRED_UNIT_TOKEN_IN_OBJECT_NAME.exec(canonical);
    if (!match) continue;
    const token = match[1];
    if (token == null || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/**
 * How much of the package being prepared is named by recorded dispatch links.
 * One recorded unit is partial: the remaining units still need Send. Full
 * means every current package token was recorded, including tokens spread
 * across more than one link. An empty package is not a completed send.
 */
export function currentPackageDispatchCoverage(input: {
  packageTokens: readonly string[];
  recordedTokens: readonly string[];
}): CurrentPackageDispatchCoverage {
  const required = [...new Set(input.packageTokens)];
  if (required.length === 0) return "none";
  const recorded = new Set(input.recordedTokens);
  let covered = 0;
  for (const token of required) {
    if (recorded.has(token)) covered += 1;
  }
  if (covered === 0) return "none";
  if (covered === required.length) return "full";
  return "partial";
}

/**
 * A recorded print locks the current package only when one of its Required-unit
 * tokens is in that package. Dismissed records and other Builds do not count.
 * Filename equality is not an identity.
 */
export function recordedPrintsLockProductionMethod(input: {
  profileId: number;
  packageTokens: readonly string[];
  records: readonly RecordedPrintIdentity[];
}): boolean {
  const packageTokens = new Set(input.packageTokens);
  if (packageTokens.size === 0) return false;
  for (const record of input.records) {
    if (record.profileId !== input.profileId || record.state === "dismissed") continue;
    for (const token of requiredUnitTokensInObjectNames(record.objectNames)) {
      if (packageTokens.has(token)) return true;
    }
  }
  return false;
}
