const JOB_KIND_LABELS: Record<string, string> = {
  export: "Export",
  "export-accepted-plate-3mf": "Accepted Plate 3MF",
  kit: "Kit bundle",
  "stl-export": "STL export",
  sync: "Sync",
  scan: "Import scan",
  job: "Background job",
  "printer-upload": "Send to printer",
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind] ?? kind.replace(/-/g, " ");
}
