import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPrinter,
  updatePrinterDetails,
  type AddPrinterInput,
  type PrinterDetailsInput,
  type PrinterMachine,
} from "./engine";

const created: PrinterMachine = {
  id: "printer-shop-voron",
  name: "Shop Voron",
  model: "voron-250",
  bed_width_mm: 250,
  bed_depth_mm: 250,
  bed_height_mm: 250,
  margin_mm: 4,
  max_filament_slots: 1,
  loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
};

const inputs: Array<{
  input: AddPrinterInput;
  wire: Record<string, unknown>;
}> = [
  {
    input: {
      kind: "preset",
      name: "Shop Voron",
      preset_id: "preset-voron-250",
    },
    wire: { name: "Shop Voron", preset_id: "preset-voron-250" },
  },
  {
    input: {
      kind: "custom",
      name: "Wide bed",
      model: "Custom 400",
      bed_width_mm: 400,
      bed_depth_mm: 400,
      bed_height_mm: 450,
    },
    wire: {
      name: "Wide bed",
      model: "Custom 400",
      bed_width_mm: 400,
      bed_depth_mm: 400,
      bed_height_mm: 450,
    },
  },
];

describe("Printer API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(inputs)("serializes the $input.kind planning printer variant", async ({ input, wire }) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(wire);
      return new Response(JSON.stringify(created), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(addPrinter(input)).resolves.toEqual(created);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("serializes editable printer details to the dedicated route", async () => {
    const details: PrinterDetailsInput = {
      name: "Shop Voron 300",
      model: "Voron 2.4 300",
      bed_width_mm: 300,
      bed_depth_mm: 305,
      bed_height_mm: 310,
      margin_mm: 6,
      max_filament_slots: 2,
      preset_id: null,
    };
    const updated = { ...created, ...details };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/printers\/printer%2Fshop\/details$/);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual(details);
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePrinterDetails("printer/shop", details)).resolves.toEqual(updated);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
