import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PrinterSendQueueItem } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { computePrinterQueueSuggestions } from "./printer-queue-suggestions.js";
import { productionPackingBuckets } from "./production-packing-rules.js";

// Preserve the queue suite's mocked filament lookup boundary. Its exact results
// are explicit JSON inputs so the Rust harness need not infer filenames.
vi.mock("./printer-farm-match.js", () => ({
  wantedFilamentIdsForQueueItem: vi.fn(),
}));
const { wantedFilamentIdsForQueueItem: mockedWanted } = await import("./printer-farm-match.js");
const { wantedFilamentIdsForQueueItem } = await vi.importActual<
  typeof import("./printer-farm-match.js")
>("./printer-farm-match.js");

type FarmInput = {
  parts: Array<{ id: number; filament_color_id: string | null }>;
  item: PrinterSendQueueItem;
};
type QueueInput = {
  fleet: Parameters<typeof computePrinterQueueSuggestions>[1];
  idleIntegrationIds: string[];
  queuedItems: PrinterSendQueueItem[];
  wantedFilamentIdsByItem: Record<string, string[]>;
};
type PackingInput = {
  units: Parameters<typeof productionPackingBuckets>[0];
  rules: Parameters<typeof productionPackingBuckets>[1];
};
type GoldenFile<T> = {
  schemaVersion: number;
  helper: string;
  cases: Array<{ name: string; input: T; output: unknown }>;
};

const update = process.env.UPDATE_FARM_PARITY === "1";

function check<T>(helper: string, evaluate: (input: T) => unknown) {
  const path = new URL(`../../../../../fixtures/parity/farm/${helper}.json`, import.meta.url);
  const golden = JSON.parse(readFileSync(path, "utf8")) as GoldenFile<T>;

  describe(`${helper} Rust parity (${golden.cases.length} cases)`, () => {
    it("covers every source test case exactly once", () => {
      const source = readFileSync(new URL(`./${helper}.test.ts`, import.meta.url), "utf8");
      const names = [...source.matchAll(/\bit\("([^"]+)"/g)].map((match) => match[1]);
      expect(golden.schemaVersion).toBe(1);
      expect(golden.helper).toBe(helper);
      expect(names.length).toBeGreaterThan(0);
      expect(golden.cases.map(({ name }) => name)).toEqual(names);
      expect(new Set(names).size).toBe(names.length);
    });

    for (const testCase of golden.cases) {
      it(testCase.name, () => {
        // JSON is the cross-language boundary. Normalize only farm sets;
        // queue and bucket output ordering is significant.
        const actual: unknown = JSON.parse(JSON.stringify(evaluate(testCase.input)));
        if (update) {
          testCase.output = actual;
          writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
        } else {
          expect(actual).toEqual(testCase.output);
        }
      });
    }
  });
}

check<FarmInput>("printer-farm-match", ({ parts, item }) => {
  const repo = { listParts: () => ({ parts, total: parts.length }) } as unknown as AppRepository;
  return [...wantedFilamentIdsForQueueItem(repo, item)].sort();
});

check<QueueInput>("printer-queue-suggestions", (input) => {
  vi.mocked(mockedWanted).mockImplementation((_repo, item) => {
    const ids = input.wantedFilamentIdsByItem[item.id];
    if (!ids) throw new Error(`Missing filament mock input for ${item.id}`);
    return new Set(ids);
  });
  return computePrinterQueueSuggestions(
    {} as AppRepository,
    input.fleet,
    new Set(input.idleIntegrationIds),
    input.queuedItems,
  );
});

check<PackingInput>("production-packing-rules", ({ units, rules }) =>
  productionPackingBuckets(units, rules),
);
