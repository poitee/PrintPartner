import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type CustomFilament = {
  id: string;
  display_name: string;
  product_line: string;
  hex: string;
  combo_label: string;
};

type Store = { filaments: CustomFilament[] };

function storePath(dataDir: string): string {
  return join(dataDir, "custom_filaments.json");
}

function loadStore(dataDir: string): Store {
  const path = storePath(dataDir);
  if (!existsSync(path)) return { filaments: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return { filaments: [] };
  }
}

function saveStore(dataDir: string, store: Store): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2), "utf8");
}

export function listCustomFilaments(dataDir: string): CustomFilament[] {
  return loadStore(dataDir).filaments;
}

export function addCustomFilament(
  dataDir: string,
  body: { display_name: string; hex: string; product_line?: string },
): CustomFilament {
  const name = body.display_name.trim();
  if (!name) throw new Error("display_name is required");
  const hex = body.hex.trim().replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) throw new Error("hex must be 6-digit RGB");
  const entry: CustomFilament = {
    id: `custom-${randomUUID().slice(0, 8)}`,
    display_name: name,
    product_line: body.product_line?.trim() || "Custom",
    hex: `#${hex}`,
    combo_label: name,
  };
  const store = loadStore(dataDir);
  store.filaments.push(entry);
  saveStore(dataDir, store);
  return entry;
}

export function deleteCustomFilament(dataDir: string, filamentId: string): void {
  const store = loadStore(dataDir);
  const next = store.filaments.filter((f) => f.id !== filamentId);
  if (next.length === store.filaments.length) throw new Error("Filament not found");
  saveStore(dataDir, { filaments: next });
}
