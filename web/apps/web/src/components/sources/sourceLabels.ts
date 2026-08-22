export type SourceKind =
  | "github"
  | "local"
  | "printables"
  | "makerworld"
  | "self"
  | "archive";

export const KIND_LABELS: Record<SourceKind, string> = {
  github: "GitHub",
  local: "Local folder",
  printables: "Printables",
  makerworld: "MakerWorld",
  self: "URL / other",
  archive: "Archive (zip)",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as SourceKind] ?? kind;
}

export const UNCategorized_FILTER = "__uncategorized__";
