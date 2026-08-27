export function readStickyId(key: string, storage: Storage | undefined = globalThis.localStorage): string {
  try {
    return storage?.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeStickyId(
  key: string,
  id: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (id) storage?.setItem(key, id);
    else storage?.removeItem(key);
  } catch {
    /* ignore quota / private mode */
  }
}
