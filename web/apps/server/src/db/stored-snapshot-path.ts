import { isAbsolute, resolve, sep } from "node:path";

export function resolveStoredSnapshotPath(reposDir: string, locator: string): string | null {
  const segments = locator.replaceAll("\\", "/").split("/");
  if (
    isAbsolute(locator) ||
    locator.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const reposRoot = resolve(reposDir);
  const snapshotPath = resolve(reposRoot, locator);
  if (snapshotPath === reposRoot || !snapshotPath.startsWith(`${reposRoot}${sep}`)) {
    return null;
  }
  return snapshotPath;
}
