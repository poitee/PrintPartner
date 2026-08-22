import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSpoolmanFilamentId,
  buildSpoolmanSpoolId,
  formatSpoolOptionLabel,
  formatSpoolSummaryBadge,
  formatSpoolmanFilamentLabel,
  listSpoolmanFilaments,
  normalizeSpoolmanBaseUrl,
  normalizeSpoolmanHex,
  normalizeSpoolmanSpool,
  normalizeSpoolmanVendor,
  parseSpoolmanFilamentId,
  parseSpoolmanFilamentList,
  parseSpoolmanSpoolId,
  parseSpoolmanSpoolList,
  spoolSummariesForFilament,
  spoolSummariesForPart,
  spoolmanFilamentToCatalogColor,
  testSpoolmanConnection,
} from "./spoolman-client.js";

describe("spoolman-client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses and builds spoolman filament ids", () => {
    const id = buildSpoolmanFilamentId("abc-123", 42);
    expect(id).toBe("spoolman:abc-123:filament:42");
    expect(parseSpoolmanFilamentId(id)).toEqual({
      integrationId: "abc-123",
      filamentId: 42,
    });
    expect(parseSpoolmanFilamentId("primary::gray")).toBeNull();
  });

  it("normalizes hex and labels", () => {
    expect(normalizeSpoolmanHex("c41230")).toBe("#c41230");
    expect(normalizeSpoolmanHex("#abc")).toBe("#abc");
    expect(
      formatSpoolmanFilamentLabel({
        id: 1,
        name: "Red",
        vendor: "Polymaker",
        material: "PLA",
        color_hex: "#ff0000",
      }),
    ).toBe("Polymaker PLA · Red");
  });

  it("maps filament to catalog color", () => {
    const color = spoolmanFilamentToCatalogColor("int-1", {
      id: 7,
      name: "Black",
      vendor: "Bambu",
      material: "PETG",
      color_hex: "000000",
    });
    expect(color.id).toBe("spoolman:int-1:filament:7");
    expect(color.hex).toBe("#000000");
    expect(color.combo_label).toContain("Bambu");
  });

  it("summarizes spools for a filament", () => {
    const spools = [
      { id: 3, filament_id: 7, remaining_weight: 420.2 },
      { id: 4, filament_id: 8, remaining_weight: 100 },
      { id: 5, filament_id: 7, remaining_weight: 0 },
    ];
    const summaries = spoolSummariesForFilament(spools, 7);
    expect(summaries).toEqual([{ spool_id: 3, remaining_g: 420.2 }]);
    expect(formatSpoolSummaryBadge(summaries)).toBe("~420 g on spool #3");
  });

  it("parses spool ids and prefers a selected spool", () => {
    const spoolRef = buildSpoolmanSpoolId("int-1", 3);
    expect(parseSpoolmanSpoolId(spoolRef)).toEqual({ integrationId: "int-1", spoolId: 3 });
    const spools = [
      { id: 3, filament_id: 7, remaining_weight: 420.2, location: "Shelf A" },
      { id: 8, filament_id: 7, remaining_weight: 200 },
    ];
    expect(spoolSummariesForPart(spools, 7, spoolRef)).toEqual([
      { spool_id: 3, remaining_g: 420.2 },
    ]);
    expect(spoolSummariesForPart(spools, 7, null)).toHaveLength(2);
    expect(formatSpoolOptionLabel(spools[0]!)).toBe("#3 · ~420 g · Shelf A");
  });

  it("testSpoolmanConnection succeeds on /info", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: "0.22.0" }),
      })),
    );
    const result = await testSpoolmanConnection({ base_url: "http://127.0.0.1:7912" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain("Connected");
  });

  it("testSpoolmanConnection requires base_url", async () => {
    const result = await testSpoolmanConnection({});
    expect(result).toEqual({ ok: false, message: "base_url is required" });
  });

  it("normalizeSpoolmanVendor accepts nested vendor object", () => {
    expect(normalizeSpoolmanVendor({ id: 2, name: "Polymaker" })).toBe("Polymaker");
    expect(normalizeSpoolmanVendor("Bambu")).toBe("Bambu");
  });

  it("parseSpoolmanFilamentList normalizes Spoolman API vendor objects", () => {
    const rows = parseSpoolmanFilamentList([
      {
        id: 1,
        name: "Red",
        vendor: { id: 2, name: "Polymaker" },
        material: "PLA",
        color_hex: "#ff0000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.vendor).toBe("Polymaker");
    expect(formatSpoolmanFilamentLabel(rows[0]!)).toBe("Polymaker PLA · Red");
  });

  it("normalizeSpoolmanBaseUrl strips accidental /api/v1 suffix", () => {
    expect(normalizeSpoolmanBaseUrl("http://192.168.1.50:7912/api/v1/")).toBe(
      "http://192.168.1.50:7912",
    );
  });

  it("listSpoolmanFilaments parses array response with vendor objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: 1,
            name: "A",
            vendor: { id: 9, name: "VendorCo" },
            material: "PLA",
            color_hex: "#111111",
          },
        ],
      })),
    );
    const rows = await listSpoolmanFilaments({ base_url: "http://127.0.0.1:7912" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.vendor).toBe("VendorCo");
  });

  it("listSpoolmanFilaments throws when base_url missing", async () => {
    await expect(listSpoolmanFilaments({})).rejects.toThrow(/base_url is required/);
  });

  it("normalizeSpoolmanSpool reads nested filament id and skips archived", () => {
    expect(
      normalizeSpoolmanSpool({
        id: 3,
        filament: { id: 7 },
        remaining_weight: 100,
      }),
    ).toEqual({ id: 3, filament_id: 7, remaining_weight: 100, location: null });
    expect(
      normalizeSpoolmanSpool({
        id: 4,
        filament_id: 7,
        remaining_weight: 50,
        archived: true,
      }),
    ).toBeNull();
  });

  it("parseSpoolmanSpoolList unwraps paginated responses", () => {
    expect(
      parseSpoolmanSpoolList({
        items: [{ id: 1, filament_id: 2, remaining_weight: 10 }],
      }),
    ).toEqual([{ id: 1, filament_id: 2, remaining_weight: 10, location: null }]);
  });
});
