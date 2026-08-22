export type AuxiliaryErrors = Record<string, string>;

export function setAuxiliaryError(
  errors: AuxiliaryErrors,
  key: string,
  message: string,
): AuxiliaryErrors {
  const next = { ...errors };
  delete next[key];
  return { ...next, [key]: message };
}

export function clearAuxiliaryError(
  errors: AuxiliaryErrors,
  key: string,
): AuxiliaryErrors {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function currentAuxiliaryError(errors: AuxiliaryErrors): string | null {
  return Object.values(errors).at(-1) ?? null;
}
