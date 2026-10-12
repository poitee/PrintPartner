const REQUIRED_UNIT_TOKEN_IN_OBJECT_NAME = /__(ppu_[0-9a-f]{32})$/;

export type RecordedPrintIdentity = Readonly<{
  profileId: number;
  state: string;
  objectNames: readonly (string | null | undefined)[];
}>;

/** Required-unit tokens carried in object names. A bare filename contributes none. */
export function requiredUnitTokensInObjectNames(
  names: readonly (string | null | undefined)[],
): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const match = name ? REQUIRED_UNIT_TOKEN_IN_OBJECT_NAME.exec(name) : null;
    if (!match) continue;
    const token = match[1];
    if (token == null || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
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
