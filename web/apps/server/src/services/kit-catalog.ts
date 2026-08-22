import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function loadKitCatalog(): Record<string, unknown> {
  const jsonPath = dataPath("manifests", "kit-catalog.json");
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  for (const yamlPath of [
    dataPath("kit-catalog.yaml"),
    dataPath("manifests", "kit-catalog.yaml"),
    srcDataPath("kit-catalog.yaml"),
    srcDataPath("manifests", "kit-catalog.yaml"),
  ]) {
    try {
      const raw = yaml.load(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      return raw;
    } catch {
      /* try next */
    }
  }
  return { version: 1, bases: {}, addon_categories: {}, stack_presets: {} };
}
