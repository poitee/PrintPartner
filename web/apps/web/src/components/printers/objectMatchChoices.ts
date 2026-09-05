import type { PrintFileMatchReview, PrinterObjectMapping } from "@print-partner/contracts";
import { requiredUnitToken } from "./printFileAssignment";

export type ObjectMatchChoices = ReadonlyMap<number, number>;

export function allocateObjectChoices(
  review: PrintFileMatchReview | undefined,
  choices: ObjectMatchChoices,
  positiveTokens: ReadonlySet<string>,
) {
  const tokens = new Set(positiveTokens);
  const mappings: PrinterObjectMapping[] = [];
  const shortages: string[] = [];
  for (const object of review?.objects ?? []) {
    const partId = choices.get(object.object_index);
    if (partId === undefined) continue;
    const part = review?.parts.find((candidate) => candidate.part_id === partId);
    const unit = part?.units.find((candidate) => !tokens.has(requiredUnitToken(candidate)));
    if (!unit) {
      shortages.push(`Copies beyond the remaining quantity for ${part?.filename ?? object.name} will be imported as additional parts. Plan quantities will not change.`);
      continue;
    }
    tokens.add(requiredUnitToken(unit));
    mappings.push({ object_index: object.object_index, part_id: unit.part_id, unit_index: unit.unit_index });
  }
  return { tokens, mappings, shortages: [...new Set(shortages)] };
}
