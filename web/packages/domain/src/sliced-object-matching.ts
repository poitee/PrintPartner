export type SlicedObjectNameWrapper =
  | "orca_copy"
  | "prusa_instance"
  | "objects_info_instance"
  | "plain";

export type InterpretedSlicedObjectName = Readonly<{
  rawName: string;
  unwrappedName: string;
  pathKey: string;
  basenameKey: string;
  unitStemKey: string;
  wrapper: SlicedObjectNameWrapper;
  copyIndex: number | null;
}>;

export type SlicedObjectNameMatch =
  | Readonly<{
      kind: "matched";
      filename: string;
      basis: "path" | "filename" | "unit_suffix" | "fuzzy";
      score?: number;
    }>
  | Readonly<{
      kind: "ambiguous";
      basis: "path" | "filename" | "unit_suffix" | "fuzzy";
      filenames: readonly string[];
    }>
  | Readonly<{
      kind: "unmatched";
      suggestions: readonly Readonly<{ filename: string; score: number }>[];
    }>;

const ORCA_COPY = /^(.+)_id_(\d+)_copy_(\d+)$/i;
const PRUSA_INSTANCE = /_+instance_(\d+)_?$/i;
const OBJECTS_INFO_INSTANCE = /\s*\(instance\s+(\d+)\)\s*$/i;
const MESH_EXTENSION = /\.(?:stl|3mf|gcode|gco|bgcode)$/i;
const UNIT_SUFFIX = /_(\d{1,3})$/u;

function stripEnclosingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "'" && last === "'") || (first === '"' && last === '"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripMeshExtensions(value: string): string {
  let result = value;
  for (let i = 0; i < 4; i += 1) {
    const next = result.replace(MESH_EXTENSION, "");
    if (next === result) break;
    result = next;
  }
  return result.replace(/_stl$/i, "");
}

function comparisonSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function comparisonPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map(comparisonSegment)
    .filter(Boolean)
    .join("/");
}

export function interpretSlicedObjectName(rawName: string): InterpretedSlicedObjectName {
  let unwrappedName = stripEnclosingQuotes(decodePath(rawName));
  let wrapper: SlicedObjectNameWrapper = "plain";
  let copyIndex: number | null = null;

  const orca = ORCA_COPY.exec(unwrappedName);
  if (orca) {
    unwrappedName = orca[1]!;
    copyIndex = Number.parseInt(orca[3]!, 10);
    wrapper = "orca_copy";
  } else {
    const objectsInfo = OBJECTS_INFO_INSTANCE.exec(unwrappedName);
    if (objectsInfo) {
      unwrappedName = unwrappedName.slice(0, objectsInfo.index);
      copyIndex = Math.max(0, Number.parseInt(objectsInfo[1]!, 10) - 1);
      wrapper = "objects_info_instance";
    } else {
      const prusa = PRUSA_INSTANCE.exec(unwrappedName);
      if (prusa) {
        unwrappedName = unwrappedName.slice(0, prusa.index).replace(/_+$/u, "");
        copyIndex = Math.max(0, Number.parseInt(prusa[1]!, 10) - 1);
        wrapper = "prusa_instance";
      }
    }
  }

  const pathWithoutExtensions = stripMeshExtensions(unwrappedName.replace(/\\/g, "/"));
  const pathKey = comparisonPath(pathWithoutExtensions);
  const slash = pathKey.lastIndexOf("/");
  const basenameKey = slash >= 0 ? pathKey.slice(slash + 1) : pathKey;
  const unitStemKey = basenameKey.replace(UNIT_SUFFIX, "") || basenameKey;

  return {
    rawName,
    unwrappedName,
    pathKey,
    basenameKey,
    unitStemKey,
    wrapper,
    copyIndex,
  };
}

type IndexedFilename = Readonly<{
  filename: string;
  interpreted: InterpretedSlicedObjectName;
}>;

function exactOutcome(
  basis: "path" | "filename" | "unit_suffix",
  rows: readonly IndexedFilename[],
): SlicedObjectNameMatch | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    return { kind: "matched", filename: rows[0]!.filename, basis };
  }
  return { kind: "ambiguous", basis, filenames: rows.map((row) => row.filename) };
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

const CONTRAST_GROUPS = [
  ["left", "right"],
  ["front", "rear"],
  ["top", "bottom"],
  ["upper", "lower"],
  ["inner", "outer"],
] as const;

function semanticTokens(key: string): Set<string> {
  return new Set(key.split("_").filter(Boolean));
}

function semanticTokensAgree(leftKey: string, rightKey: string): boolean {
  const left = semanticTokens(leftKey);
  const right = semanticTokens(rightKey);
  const leftNumbers = [...left].filter((token) => /^\d+$/u.test(token));
  const rightNumbers = [...right].filter((token) => /^\d+$/u.test(token));
  if (leftNumbers.join(",") !== rightNumbers.join(",")) return false;

  const leftAxes = [...left].filter((token) => token === "x" || token === "y" || token === "z");
  const rightAxes = [...right].filter((token) => token === "x" || token === "y" || token === "z");
  if (leftAxes.join(",") !== rightAxes.join(",")) return false;

  for (const group of CONTRAST_GROUPS) {
    const leftToken = group.find((token) => left.has(token));
    const rightToken = group.find((token) => right.has(token));
    if (leftToken !== rightToken) return false;
  }
  return true;
}

function fuzzyScore(leftKey: string, rightKey: string): { distance: number; score: number } {
  const left = leftKey.replace(/_/g, "");
  const right = rightKey.replace(/_/g, "");
  const distance = levenshtein(left, right);
  return { distance, score: 1 - distance / Math.max(left.length, right.length, 1) };
}

/** Advisory import candidates only; selecting one always requires the operator. */
export function suggestSlicedObjectNames(rawName: string, filenames: readonly string[]): string[] {
  const key = (name: string) => interpretSlicedObjectName(name).basenameKey
    .replace(/(\d+)(?:_?by_?|x)(\d+)/g, "$1x$2");
  const observed = key(rawName);
  if (!observed) return [];
  const numbers = (value: string) => (value.match(/\d+/g) ?? []).join(",");
  return filenames.map((filename) => ({ filename, key: key(filename) }))
    .filter((row) => semanticTokensAgree(observed, row.key) && numbers(observed) === numbers(row.key))
    .map((row) => ({ ...row, score: fuzzyScore(observed, row.key).score }))
    .filter((row) => row.score >= 0.6)
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, 3).map((row) => row.filename);
}

/**
 * Match one slicer label to library filenames. Exact path and basename evidence
 * wins; bounded fuzzy matching is allowed only for a unique semantic match.
 */
export function matchSlicedObjectName(
  rawName: string,
  libraryFilenames: readonly string[],
): SlicedObjectNameMatch {
  const observed = interpretSlicedObjectName(rawName);
  if (!observed.basenameKey) return { kind: "unmatched", suggestions: [] };
  const indexed = libraryFilenames.map((filename) => ({
    filename,
    interpreted: interpretSlicedObjectName(filename),
  }));

  const hasObservedPath = observed.pathKey.includes("/");
  if (hasObservedPath) {
    const path = exactOutcome(
      "path",
      indexed.filter((row) => row.interpreted.pathKey === observed.pathKey),
    );
    if (path) return path;
  }

  const filename = exactOutcome(
    "filename",
    indexed.filter((row) => row.interpreted.basenameKey === observed.basenameKey),
  );
  if (filename) return filename;

  if (observed.unitStemKey !== observed.basenameKey) {
    const unit = exactOutcome(
      "unit_suffix",
      indexed.filter((row) => row.interpreted.basenameKey === observed.unitStemKey),
    );
    if (unit) return unit;
  }

  const fuzzy = indexed
    .map((row) => ({
      ...row,
      ...fuzzyScore(observed.unitStemKey, row.interpreted.basenameKey),
      semantic: semanticTokensAgree(observed.unitStemKey, row.interpreted.basenameKey),
    }))
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename));
  const best = fuzzy[0];
  if (!best) return { kind: "unmatched", suggestions: [] };
  const runnerUp = fuzzy[1];
  const compactLength = observed.unitStemKey.replace(/_/g, "").length;
  const maxDistance = compactLength >= 12 ? 2 : 1;
  const clearsThreshold =
    compactLength >= 8 &&
    best.semantic &&
    best.distance <= maxDistance &&
    best.score >= 0.9;
  const clearsMargin = runnerUp == null || best.score - runnerUp.score >= 0.08;
  if (clearsThreshold && clearsMargin) {
    return {
      kind: "matched",
      filename: best.filename,
      basis: "fuzzy",
      score: best.score,
    };
  }

  const close = fuzzy.filter((row) => best.score - row.score < 0.08);
  if (clearsThreshold && close.length > 1) {
    return {
      kind: "ambiguous",
      basis: "fuzzy",
      filenames: close.map((row) => row.filename),
    };
  }
  return {
    kind: "unmatched",
    suggestions: fuzzy.slice(0, 3).map((row) => ({
      filename: row.filename,
      score: row.score,
    })),
  };
}
