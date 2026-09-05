import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  fetchSourceDocMarkdown,
  fetchSourceDocs,
  fetchSourceNotes,
  fetchSourceReadme,
  type SourceDocSummary,
  type SourceNote,
} from "../api/endpoints/sourceContent";

const sourceContentKeys = {
  docs: (sourceId: number) => ["sourceContent", sourceId, "docs"] as const,
  notes: (sourceId: number) => ["sourceContent", sourceId, "notes"] as const,
  readme: (sourceId: number) => ["sourceContent", sourceId, "liveReadme"] as const,
  document: (sourceId: number, path: string) =>
    ["sourceContent", sourceId, "document", path] as const,
};

export function invalidateSourceContent(
  queryClient: QueryClient,
  sourceId?: number,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: sourceId == null ? ["sourceContent"] : ["sourceContent", sourceId],
  });
}

type SourceContentResult = Readonly<{
  docs: SourceDocSummary[];
  notes: SourceNote[];
  activeDoc: string | null;
  selectDocument: (path: string) => void;
  documentContent: string;
  documentLoading: boolean;
  documentError: Error | null;
  loading: boolean;
  loadError: Error | null;
  liveReadme: Awaited<ReturnType<typeof fetchSourceReadme>> | null;
  reload: () => void;
  retryDocument: () => void;
  updateNotes: (update: (current: SourceNote[]) => SourceNote[]) => void;
}>;

type DocumentSelection = Readonly<{
  sourceId: number;
  path: string;
}>;

type UseSourceContentOptions = Readonly<{
  enabled: boolean;
  liveReadmeFallback?: boolean;
}>;

export function useSourceContent(
  sourceId: number,
  { enabled, liveReadmeFallback = false }: UseSourceContentOptions,
): SourceContentResult {
  const queryClient = useQueryClient();
  const docsQuery = useQuery({
    queryKey: sourceContentKeys.docs(sourceId),
    queryFn: () => fetchSourceDocs(sourceId),
    enabled,
  });
  const notesQuery = useQuery({
    queryKey: sourceContentKeys.notes(sourceId),
    queryFn: () => fetchSourceNotes(sourceId),
    enabled,
  });
  const shouldLoadLiveReadme =
    enabled &&
    liveReadmeFallback &&
    docsQuery.isSuccess &&
    docsQuery.data.length === 0;
  const readmeQuery = useQuery({
    queryKey: sourceContentKeys.readme(sourceId),
    queryFn: () => fetchSourceReadme(sourceId, true),
    enabled: shouldLoadLiveReadme,
  });
  const usingLiveReadmeFallback =
    shouldLoadLiveReadme && Boolean(readmeQuery.data?.markdown);

  const docs = useMemo<SourceDocSummary[]>(() => {
    const syncedDocs = docsQuery.data ?? [];
    if (!usingLiveReadmeFallback) return syncedDocs;
    return [{ path: "README.md", title: "README (live)", kind: "readme" }];
  }, [docsQuery.data, usingLiveReadmeFallback]);
  const notes = notesQuery.data ?? [];
  const loadError =
    docsQuery.error ??
    notesQuery.error ??
    (shouldLoadLiveReadme ? readmeQuery.error : null);
  const loading =
    enabled &&
    (docsQuery.isPending ||
      notesQuery.isPending ||
      (shouldLoadLiveReadme && readmeQuery.isPending));

  const [selection, setSelection] = useState<DocumentSelection | null>(null);
  const activeDoc = selection?.sourceId === sourceId ? selection.path : null;

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    if (loading || loadError) return;
    setSelection((current) => {
      if (
        current?.sourceId === sourceId &&
        docs.some((document) => document.path === current.path)
      ) {
        return current;
      }
      const first = docs[0];
      return first ? { sourceId, path: first.path } : null;
    });
  }, [docs, enabled, loadError, loading, sourceId]);

  const liveReadmeSelected = usingLiveReadmeFallback && activeDoc === "README.md";
  const documentQuery = useQuery({
    queryKey: sourceContentKeys.document(sourceId, activeDoc ?? ""),
    queryFn: () => fetchSourceDocMarkdown(sourceId, activeDoc ?? ""),
    enabled: enabled && activeDoc != null && !liveReadmeSelected,
  });

  const selectDocument = useCallback(
    (path: string) => {
      if (!docs.some((document) => document.path === path)) return;
      setSelection({ sourceId, path });
    },
    [docs, sourceId],
  );

  const reload = useCallback(() => {
    void Promise.allSettled([
      docsQuery.refetch(),
      notesQuery.refetch(),
      ...(shouldLoadLiveReadme ? [readmeQuery.refetch()] : []),
    ]);
  }, [docsQuery, notesQuery, readmeQuery, shouldLoadLiveReadme]);

  const retryDocument = useCallback(() => {
    if (liveReadmeSelected) {
      void readmeQuery.refetch();
      return;
    }
    void documentQuery.refetch();
  }, [documentQuery, liveReadmeSelected, readmeQuery]);

  const updateNotes = useCallback(
    (update: (current: SourceNote[]) => SourceNote[]) => {
      queryClient.setQueryData<SourceNote[]>(sourceContentKeys.notes(sourceId), (current) =>
        update(current ?? []),
      );
    },
    [queryClient, sourceId],
  );

  return {
    docs,
    notes,
    activeDoc,
    selectDocument,
    documentContent: liveReadmeSelected
      ? (readmeQuery.data?.markdown ?? "")
      : (documentQuery.data ?? ""),
    documentLoading: activeDoc != null && !liveReadmeSelected && documentQuery.isPending,
    documentError: liveReadmeSelected ? readmeQuery.error : documentQuery.error,
    loading,
    loadError,
    liveReadme: usingLiveReadmeFallback ? (readmeQuery.data ?? null) : null,
    reload,
    retryDocument,
    updateNotes,
  };
}
