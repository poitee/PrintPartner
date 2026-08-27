export function sourceIdFromParams(params: unknown): number | null {
  if (typeof params !== "object" || params === null || !("id" in params)) return null;
  const value = params.id;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const sourceId = Number(value);
  return Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null;
}
