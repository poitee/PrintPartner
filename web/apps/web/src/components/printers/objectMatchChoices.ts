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
      shortages.push(`Not enough remaining units for ${part?.filename ?? object.name}. Reduce the copies or choose another part.`);
      continue;
    }
    tokens.add(requiredUnitToken(unit));
    mappings.push({ object_index: object.object_index, part_id: unit.part_id, unit_index: unit.unit_index });
  }
  if (tokens.size > 500) shortages.push("Choose no more than 500 units for one import.");
  return { tokens, mappings, shortages: [...new Set(shortages)] };
}
