import type { GithubRefType } from "../components/GitHubRefField";
import type { SourceKind } from "../components/sources/sourceLabels";

export type SourceSaveDraft = {
  name: string;
  url: string;
  refType: GithubRefType;
  branch: string;
  tag: string;
  source_kind: SourceKind;
  category: string;
};

export type SourceSavePayload = {
  name: string;
  url: string;
  branch: string;
  tag: string | null;
  source_kind: SourceKind;
  category: string | null;
};

export function sourceSavePayloadFromDraft(draft: SourceSaveDraft): SourceSavePayload {
  if (draft.source_kind === "github" && draft.refType === "tag" && !draft.tag.trim()) {
    throw new Error("Enter a tag or switch back to Branch.");
  }
  if (
    (draft.source_kind === "printables" ||
      draft.source_kind === "makerworld" ||
      draft.source_kind === "thangs") &&
    !draft.url.trim()
  ) {
    throw new Error("Enter the model page URL from Printables, MakerWorld, or Thangs.");
  }

  const refFields =
    draft.source_kind === "github" && draft.refType === "tag"
      ? { branch: draft.branch.trim() || "main", tag: draft.tag.trim() }
      : { branch: draft.branch.trim() || "main", tag: null };

  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    ...refFields,
    source_kind: draft.source_kind,
    category: draft.category.trim() || null,
  };
}
