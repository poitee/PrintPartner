import type { SourceSummary } from "@print-partner/contracts";
import type { SourceKind } from "../components/sources/sourceLabels";

export type SourceWizardDraft = {
  name: string;
  url: string;
  refType: "branch" | "tag";
  branch: string;
  tag: string;
  source_kind: SourceKind;
  category: string;
  pendingFiles: File[];
  pendingZip: File | null;
};

const SOURCE_KINDS: readonly SourceKind[] = [
  "github",
  "local",
  "printables",
  "makerworld",
  "thangs",
  "self",
  "archive",
];

export function isSourceKind(value: string | null | undefined): value is SourceKind {
  return SOURCE_KINDS.some((kind) => kind === value);
}

export function newSourceWizardDraft(categories: readonly string[], kind?: SourceKind): SourceWizardDraft {
  return {
    name: "",
    url: "",
    refType: "branch",
    branch: "main",
    tag: "",
    source_kind: kind ?? "github",
    category: categories[0] ?? "",
    pendingFiles: [],
    pendingZip: null,
  };
}

export function sourceWizardDraftFromSource(source: SourceSummary): SourceWizardDraft {
  return {
    name: source.name,
    url: source.url,
    refType: source.tag ? "tag" : "branch",
    branch: source.branch || "main",
    tag: source.tag ?? "",
    source_kind: isSourceKind(source.source_kind) ? source.source_kind : "github",
    category: source.category ?? "",
    pendingFiles: [],
    pendingZip: null,
  };
}
