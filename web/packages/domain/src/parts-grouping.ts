export const ROOT_FOLDER = "(root)";

export function folderKeyFromRelativePath(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  parts.pop();
  const parent = parts.join("/");
  if (!parent || parent === ".") return ROOT_FOLDER;
  return parent;
}
