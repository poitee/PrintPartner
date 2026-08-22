import type { AppRepository } from "../db/repository.js";

export const KNOWLEDGE_BUNDLE_FORMAT = "print-partner-knowledge";
export const KNOWLEDGE_BUNDLE_VERSION = 1;

export type KnowledgeBundleNote = {
  title: string;
  body_markdown: string;
  profile_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type KnowledgeBundleDocRef = {
  path: string;
  kind: string;
  title?: string;
  annotation?: string | null;
};

export type KnowledgeBundle = {
  format: typeof KNOWLEDGE_BUNDLE_FORMAT;
  version: number;
  source: {
    name: string;
    url: string;
    branch?: string | null;
    tag?: string | null;
  };
  notes: KnowledgeBundleNote[];
  /** References to synced docs (not binary payloads). */
  doc_refs: KnowledgeBundleDocRef[];
  exported_at: string;
};

export function buildKnowledgeBundle(
  repo: AppRepository,
  sourceId: number,
): KnowledgeBundle {
  const source = repo.getSource(sourceId);
  if (!source) throw new Error("Source not found");
  const notes = repo.listSourceNotes(sourceId).map((n) => {
    const profile =
      n.profile_id != null ? repo.getOwnedProfileIdentity(n.profile_id) : null;
    return {
      title: n.title,
      body_markdown: n.body_markdown,
      profile_name: profile?.name ?? null,
      created_at: n.created_at,
      updated_at: n.updated_at,
    };
  });
  const docs = repo.listSourceDocs(sourceId);
  const doc_refs: KnowledgeBundleDocRef[] = docs.map((d) => ({
    path: d.path,
    kind: d.kind,
    title: d.title,
    annotation: null,
  }));
  return {
    format: KNOWLEDGE_BUNDLE_FORMAT,
    version: KNOWLEDGE_BUNDLE_VERSION,
    source: {
      name: source.name,
      url: source.url,
      branch: source.branch,
      tag: source.tag,
    },
    notes,
    doc_refs,
    exported_at: new Date().toISOString(),
  };
}

export function parseKnowledgeBundle(raw: unknown): KnowledgeBundle {
  if (!raw || typeof raw !== "object") throw new Error("Invalid knowledge bundle");
  const obj = raw as Record<string, unknown>;
  if (obj.format !== KNOWLEDGE_BUNDLE_FORMAT) {
    throw new Error(`Unsupported bundle format: ${String(obj.format)}`);
  }
  const version = Number(obj.version ?? 0);
  if (version !== KNOWLEDGE_BUNDLE_VERSION) {
    throw new Error(`Unsupported knowledge bundle version: ${version}`);
  }
  const sourceRaw = (obj.source ?? {}) as Record<string, unknown>;
  const name = String(sourceRaw.name ?? "").trim();
  const url = String(sourceRaw.url ?? "").trim();
  if (!name && !url) throw new Error("Bundle source name or url required");

  const notesRaw = Array.isArray(obj.notes) ? obj.notes : [];
  const notes: KnowledgeBundleNote[] = notesRaw.map((n) => {
    const row = (n ?? {}) as Record<string, unknown>;
    return {
      title: String(row.title ?? "").trim() || "Imported note",
      body_markdown: String(row.body_markdown ?? ""),
      profile_name:
        typeof row.profile_name === "string" ? row.profile_name : null,
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    };
  });

  const refsRaw = Array.isArray(obj.doc_refs) ? obj.doc_refs : [];
  const doc_refs: KnowledgeBundleDocRef[] = refsRaw.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      path: String(row.path ?? "").trim(),
      kind: String(row.kind ?? "md"),
      title: typeof row.title === "string" ? row.title : undefined,
      annotation: typeof row.annotation === "string" ? row.annotation : null,
    };
  }).filter((r) => r.path);

  return {
    format: KNOWLEDGE_BUNDLE_FORMAT,
    version: KNOWLEDGE_BUNDLE_VERSION,
    source: {
      name: name || url,
      url,
      branch: typeof sourceRaw.branch === "string" ? sourceRaw.branch : null,
      tag: typeof sourceRaw.tag === "string" ? sourceRaw.tag : null,
    },
    notes,
    doc_refs,
    exported_at:
      typeof obj.exported_at === "string"
        ? obj.exported_at
        : new Date().toISOString(),
  };
}

export function importKnowledgeBundle(
  repo: AppRepository,
  sourceId: number,
  bundle: KnowledgeBundle,
): { notes_imported: number; doc_refs: number } {
  if (!repo.getSource(sourceId)) throw new Error("Source not found");
  let notes_imported = 0;
  for (const note of bundle.notes) {
    let profileId: number | null = null;
    if (note.profile_name) {
      const match = repo.listProfileHeaders().find((p) => p.name === note.profile_name);
      profileId = match?.id ?? null;
    }
    repo.createSourceNote({
      projectId: sourceId,
      profileId,
      title: note.title,
      bodyMarkdown: note.body_markdown,
    });
    notes_imported += 1;
  }
  // Doc refs are informational — binaries are not imported.
  return { notes_imported, doc_refs: bundle.doc_refs.length };
}
