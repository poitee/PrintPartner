export type PrinterPlanBinding = Readonly<{
  integration_id: string;
  profile_id: number | null;
  updated_at: string;
}>;

const CORRUPT_BINDINGS_MESSAGE = "Printer Plan bindings are corrupt";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrinterPlanBinding(value: unknown): PrinterPlanBinding {
  if (!isJsonRecord(value)) throw new Error(CORRUPT_BINDINGS_MESSAGE);
  const integrationId = value.integration_id;
  const profileId = value.profile_id;
  const updatedAt = value.updated_at;
  if (
    typeof integrationId !== "string" ||
    !integrationId.trim() ||
    (profileId !== null && (typeof profileId !== "number" || !Number.isSafeInteger(profileId) || profileId <= 0)) ||
    typeof updatedAt !== "string"
  ) {
    throw new Error(CORRUPT_BINDINGS_MESSAGE);
  }
  return {
    integration_id: integrationId,
    profile_id: profileId,
    updated_at: updatedAt,
  };
}

export function parsePrinterPlanBindings(raw: string | null | undefined): PrinterPlanBinding[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(CORRUPT_BINDINGS_MESSAGE);
  }
  if (!Array.isArray(value)) throw new Error(CORRUPT_BINDINGS_MESSAGE);
  return value.map(parsePrinterPlanBinding);
}

export function upsertPrinterPlanBinding(
  bindings: readonly PrinterPlanBinding[],
  binding: PrinterPlanBinding,
): PrinterPlanBinding[] {
  const next = [...bindings];
  const bindingIndex = next.findIndex((candidate) => candidate.integration_id === binding.integration_id);
  if (bindingIndex >= 0) next[bindingIndex] = binding;
  else next.push(binding);
  return next;
}
