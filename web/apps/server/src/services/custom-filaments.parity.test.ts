import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addCustomFilament, listCustomFilaments } from "./custom-filaments.js";

const golden = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../../fixtures/parity/custom-filaments.json"),
    "utf8",
  ),
) as {
  entry_count: number;
  shipped_entries: unknown[];
  entry_fields: { name: string }[];
};

describe("custom filament parity golden", () => {
  it("golden entry_count matches shipped_entries", () => {
    expect(golden.entry_count).toBe(golden.shipped_entries.length);
  });

  it("TS ships the same custom filaments as the golden", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-custom-parity-"));
    try {
      expect(listCustomFilaments(dir)).toEqual(golden.shipped_entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an added custom filament has exactly the golden fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-custom-parity-"));
    try {
      const entry = addCustomFilament(dir, { display_name: " Parity Test ", hex: "cc0000" });
      expect(Object.keys(entry).sort()).toEqual(golden.entry_fields.map((f) => f.name).sort());
      expect(entry.id).toMatch(/^custom-[0-9a-f]{8}$/);
      expect(entry.display_name).toBe("Parity Test");
      expect(entry.combo_label).toBe("Parity Test");
      expect(entry.product_line).toBe("Custom");
      expect(entry.hex).toBe("#cc0000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
