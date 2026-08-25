import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data");
const SRC_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/data");

function dataPath(...parts: string[]): string {
  return join(DATA_DIR, ...parts);
}

function srcDataPath(...parts: string[]): string {
  return join(SRC_DATA_DIR, ...parts);
}

/** Empty catalog: valid shape, no opinions about what anyone is building. */
export function emptyKitCatalog(): Record<string, unknown> {
  return { version: 1, bases: {}, addon_categories: {}, stack_presets: {} };
}

function readCatalogFile(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = path.endsWith(".json")
      ? (JSON.parse(text) as unknown)
      : (yaml.load(text) as unknown);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Where to look for a kit catalog, most specific first.
 *
 * A deployment supplies its own catalog by dropping `kit-catalog.yaml` (or
 * `.json`) into its data directory — the shipped catalog carries only the
 * generic slot taxonomy, so nothing about any particular kind of project is
 * baked into the product.
 */
function candidatePaths(dataDir?: string | null): string[] {
  const paths: string[] = [];
  const tenantDir = dataDir ?? process.env.PRINT_PARTNER_DATA_DIR ?? null;
  if (tenantDir) {
    const root = isAbsolute(tenantDir) ? tenantDir : resolve(tenantDir);
    paths.push(
      join(root, "kit-catalog.json"),
      join(root, "kit-catalog.yaml"),
      join(root, "manifests", "kit-catalog.json"),
      join(root, "manifests", "kit-catalog.yaml"),
    );
  }
  paths.push(
    dataPath("manifests", "kit-catalog.json"),
    dataPath("kit-catalog.yaml"),
    dataPath("manifests", "kit-catalog.yaml"),
    srcDataPath("kit-catalog.yaml"),
    srcDataPath("manifests", "kit-catalog.yaml"),
  );
  return paths;
}

export function loadKitCatalog(dataDir?: string | null): Record<string, unknown> {
  for (const path of candidatePaths(dataDir)) {
    const catalog = readCatalogFile(path);
    if (catalog) return catalog;
  }
  return emptyKitCatalog();
}
