import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { addCustomFilament, listCustomFilaments } from "./custom-filaments.js";

const golden = z.object({
  entry_count: z.number().int().nonnegative(),
  shipped_entries: z.array(z.unknown()),
  entry_fields: z.array(z.object({
    name: z.enum(["id", "display_name", "product_line", "hex", "combo_label"]),
    type: z.string(),
    rule: z.string(),
  })),
  flags: z.array(z.string()),
  defaults: z.object({ product_line: z.string() }),
}).parse(JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../../fixtures/parity/custom-filaments.json"),
    "utf8",
  ),
));

const rules = {
  id: "custom-<8 lowercase hex chars>, generated on add",
  display_name: "trimmed, required, non-empty",
  product_line: "trimmed input or \"Custom\"",
  hex: "\"#\" + 6 hex digits (input may omit \"#\")",
  combo_label: "equals display_name",
} satisfies Record<keyof ReturnType<typeof addCustomFilament>, string>;

function withDataDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pp-custom-parity-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("custom filament parity golden", () => {
  it("golden entry_count matches shipped_entries", () => {
    expect(golden.entry_count).toBe(golden.shipped_entries.length);
    expect(golden.entry_count).toBe(0);
  });

  it("TS ships the same custom filaments as the golden", () => {
    withDataDir((dir) => {
      expect(listCustomFilaments(dir)).toEqual(golden.shipped_entries);
    });
  });

  it.each([
    ["cc0000", "#cc0000"],
    ["#AbCdEf", "#AbCdEf"],
    ["  #FF00aa  ", "#FF00aa"],
  ])("golden field types and rules match an added filament with hex %s", (hex, expectedHex) => {
    withDataDir((dir) => {
      const entry = addCustomFilament(dir, { display_name: " Parity Test ", hex });
      expect(Object.keys(entry).sort()).toEqual(golden.entry_fields.map((f) => f.name).sort());
      for (const field of golden.entry_fields) {
        expect(field.type, field.name).toBe(typeof entry[field.name]);
        expect(field.rule, field.name).toBe(rules[field.name]);
      }
      expect(entry.id).toMatch(/^custom-[0-9a-f]{8}$/);
      expect(entry.display_name).toBe("Parity Test");
      expect(entry.combo_label).toBe("Parity Test");
      expect(entry.product_line).toBe(golden.defaults.product_line);
      expect(entry.hex).toBe(expectedHex);
      expect(golden.flags).toEqual([]);
      expect(entry).not.toHaveProperty("flag");
      expect(entry).not.toHaveProperty("flags");
      expect(listCustomFilaments(dir)).toEqual([entry]);
    });
  });

  it.each([undefined, "", " \t "])("golden default applies to product_line %j", (productLine) => {
    withDataDir((dir) => {
      const body = { display_name: "Default", hex: "123456" };
      const entry = productLine === undefined
        ? addCustomFilament(dir, body)
        : addCustomFilament(dir, { ...body, product_line: productLine });
      expect(entry.product_line).toBe(golden.defaults.product_line);
      expect(listCustomFilaments(dir)).toEqual([entry]);
    });
  });

  it("preserves a trimmed, nonempty product line instead of applying the default", () => {
    withDataDir((dir) => {
      const entry = addCustomFilament(dir, {
        display_name: "Named line", hex: "123456", product_line: "  Maker line  ",
      });
      expect(entry.product_line).toBe("Maker line");
      expect(listCustomFilaments(dir)).toEqual([entry]);
    });
  });

  it.each(["", " \t\n "])("rejects empty trimmed display_name %j without saving", (displayName) => {
    withDataDir((dir) => {
      expect(() => addCustomFilament(dir, { display_name: displayName, hex: "123456" }))
        .toThrow("display_name is required");
      expect(listCustomFilaments(dir)).toEqual([]);
    });
  });

  it.each(["", "12345", "1234567", "#xyzxyz", "##123456"])("rejects invalid RGB %j without saving", (hex) => {
    withDataDir((dir) => {
      expect(() => addCustomFilament(dir, { display_name: "Invalid RGB", hex }))
        .toThrow("hex must be 6-digit RGB");
      expect(listCustomFilaments(dir)).toEqual([]);
    });
  });
});
