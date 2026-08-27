import { basename } from "node:path";

export function docTitleFromPath(path: string): string {
  const base = basename(path);
  if (/^readme\.md$/i.test(base)) return "README";
  return base;
}
