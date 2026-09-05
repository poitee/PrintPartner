export const LEGACY_BACKUP_ROOTS = [
  "repos",
  "sources",
  "exports",
  "thumbs",
  "covers",
] as const;

export const FULL_BACKUP_ROOTS = [
  { path: "repos", kind: "directory", category: "repos", label: "Source revisions" },
  { path: "sources", kind: "directory", category: "sources", label: "Working Source files" },
  { path: "exports", kind: "directory", category: "exports", label: "Exports" },
  { path: "thumbs", kind: "directory", category: "thumbs", label: "Thumbnails" },
  { path: "covers", kind: "directory", category: "covers", label: "Covers" },
  {
    path: "assistant-domain",
    kind: "directory",
    category: "assistantDomain",
    label: "Assistant knowledge",
  },
  {
    path: "manifests",
    kind: "directory",
    category: "configuration",
    label: "Configuration",
  },
  {
    path: "custom_filaments.json",
    kind: "file",
    category: "configuration",
    label: "Configuration",
  },
  {
    path: "kit-catalog.json",
    kind: "file",
    category: "configuration",
    label: "Configuration",
  },
  {
    path: "kit-catalog.yaml",
    kind: "file",
    category: "configuration",
    label: "Configuration",
  },
  {
    path: "path-hints.yaml",
    kind: "file",
    category: "configuration",
    label: "Configuration",
  },
] as const;

export type FullBackupRoot = (typeof FULL_BACKUP_ROOTS)[number]["path"];

export const FULL_BACKUP_ROOT_PATHS: readonly FullBackupRoot[] = FULL_BACKUP_ROOTS.map(
  (root) => root.path,
);

const FULL_BACKUP_ROOT_SET = new Set<string>(FULL_BACKUP_ROOT_PATHS);

export function isFullBackupRoot(value: unknown): value is FullBackupRoot {
  return typeof value === "string" && FULL_BACKUP_ROOT_SET.has(value);
}

export function backupRootForArchivePath(path: string) {
  return FULL_BACKUP_ROOTS.find(
    (root) => path === root.path || (root.kind === "directory" && path.startsWith(`${root.path}/`)),
  );
}
