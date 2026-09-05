import { useEffect, useRef, useState } from "react";
import {
  createSourceNote,
  deleteSourceNote,
  updateSourceNote,
  type SourceNote,
} from "../../api/endpoints/sourceContent";
import { useProfileSelection } from "../../context/ProfileContext";
import { useSourceContent } from "../../queries/sourceContent";
import { Button } from "../ui/button";
import { Field, FieldLabel } from "../ui/field";
import { ScrollArea } from "../ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type Props = {
  sourceId: number;
  sourceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function SourceContentLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="space-y-2 text-sm text-destructive" role="alert">
      <p>
        Could not load Source docs: {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-label="Retry loading Source docs"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export default function SourceDocsSheet({
  sourceId,
  sourceName,
  open,
  onOpenChange,
}: Props) {
  const { selectedProfileId } = useProfileSelection();
  const [tab, setTab] = useState<"synced" | "notes">("synced");
  const content = useSourceContent(sourceId, { enabled: open, liveReadmeFallback: true });
  const [notesError, setNotesError] = useState<string | null>(null);
  const [noteDraftTitle, setNoteDraftTitle] = useState("");
  const [noteDraftBody, setNoteDraftBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [notesBusy, setNotesBusy] = useState(false);
  const notesBusyRef = useRef(false);
  const noteOperationRef = useRef(0);

  useEffect(() => {
    noteOperationRef.current += 1;
    if (!open) return;
    setNotesError(null);
    notesBusyRef.current = false;
    setNotesBusy(false);
    setNoteDraftTitle("");
    setNoteDraftBody("");
    setEditingNoteId(null);
  }, [open, sourceId]);

  const saveNote = async () => {
    if (!noteDraftBody.trim() || notesBusyRef.current) return;
    const operation = noteOperationRef.current + 1;
    noteOperationRef.current = operation;
    notesBusyRef.current = true;
    setNotesBusy(true);
    setNotesError(null);
    try {
      if (editingNoteId != null) {
        const updated = await updateSourceNote(sourceId, editingNoteId, {
          title: noteDraftTitle || "Note",
          body_markdown: noteDraftBody,
        });
        if (noteOperationRef.current !== operation) return;
        content.updateNotes((current) =>
          current.map((note) => (note.id === updated.id ? updated : note)),
        );
      } else {
        const created = await createSourceNote(sourceId, {
          title: noteDraftTitle || "Note",
          body_markdown: noteDraftBody,
          profile_id:
            selectedProfileId != null && selectedProfileId > 0
              ? selectedProfileId
              : null,
        });
        if (noteOperationRef.current !== operation) return;
        content.updateNotes((current) => [...current, created]);
      }
      setNoteDraftTitle("");
      setNoteDraftBody("");
      setEditingNoteId(null);
    } catch (error) {
      if (noteOperationRef.current !== operation) return;
      const detail = error instanceof Error ? error.message : String(error);
      setNotesError(`Could not save Source note: ${detail}`);
    } finally {
      if (noteOperationRef.current === operation) {
        notesBusyRef.current = false;
        setNotesBusy(false);
      }
    }
  };

  const startEdit = (note: SourceNote) => {
    setEditingNoteId(note.id);
    setNoteDraftTitle(note.title);
    setNoteDraftBody(note.body_markdown);
  };

  const removeNote = async (noteId: number) => {
    if (notesBusyRef.current) return;
    const operation = noteOperationRef.current + 1;
    noteOperationRef.current = operation;
    notesBusyRef.current = true;
    setNotesBusy(true);
    setNotesError(null);
    try {
      await deleteSourceNote(sourceId, noteId);
      if (noteOperationRef.current !== operation) return;
      content.updateNotes((current) => current.filter((note) => note.id !== noteId));
      if (editingNoteId === noteId) {
        setEditingNoteId(null);
        setNoteDraftTitle("");
        setNoteDraftBody("");
      }
    } catch (error) {
      if (noteOperationRef.current !== operation) return;
      const detail = error instanceof Error ? error.message : String(error);
      setNotesError(`Could not delete Source note: ${detail}`);
    } finally {
      if (noteOperationRef.current === operation) {
        notesBusyRef.current = false;
        setNotesBusy(false);
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full max-w-xl flex-col">
        <SheetHeader>
          <SheetTitle className="truncate">{sourceName}</SheetTitle>
          <SheetDescription>
            Synced docs from GitHub vs Source notes (curated research + yours)
          </SheetDescription>
        </SheetHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "synced" | "notes")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 grid w-auto grid-cols-2">
            <TabsTrigger value="synced">
              Synced docs{content.docs.length > 0 ? ` (${content.docs.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="notes">
              Source notes{content.notes.length > 0 ? ` (${content.notes.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="synced" className="mt-0 min-h-0 flex-1 overflow-hidden px-4 pb-4">
            {content.loading ? (
              <p className="text-sm text-muted-foreground">Loading docs…</p>
            ) : content.loadError ? (
              <SourceContentLoadError error={content.loadError} onRetry={content.reload} />
            ) : content.docs.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {content.notes.length > 0
                    ? "No synced docs yet. Source notes are available in the other tab. Sync this Source to pull README or PDF files."
                    : "Sync this Source to pull README or PDF files from the repository."}
                </p>
                {content.notes.length > 0 ? (
                  <p>
                    {content.notes.length} Source note{content.notes.length === 1 ? "" : "s"} available.
                    Switch tabs to read them.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[140px_1fr]">
                <ScrollArea className="h-[min(60vh,420px)] rounded-md border border-border">
                  <ul className="p-2 text-sm">
                    {content.docs.map((d) => (
                      <li key={d.path}>
                        <button
                          type="button"
                          className={`w-full rounded px-2 py-1 text-left hover:bg-accent ${content.activeDoc === d.path ? "bg-accent" : ""}`}
                          onClick={() => content.selectDocument(d.path)}
                        >
                          {d.title}
                          {d.kind === "pdf" ? (
                            <span className="mt-0.5 block text-micro text-muted-foreground">
                              PDF
                              {d.extract_status && d.extract_status !== "ready"
                                ? ` · ${d.extract_status}`
                                : ""}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <ScrollArea className="h-[min(60vh,420px)] rounded-md border border-border">
                  {content.liveReadme?.source === "live" && (
                    <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                      Showing the live GitHub README because this Source has not been synced yet.
                    </p>
                  )}
                  {content.documentLoading ? (
                    <p className="p-3 text-xs text-muted-foreground" role="status">
                      Loading document…
                    </p>
                  ) : content.documentError ? (
                    <div className="space-y-2 p-3 text-xs text-destructive" role="alert">
                      <p>
                        Could not load this document: {content.documentError instanceof Error
                          ? content.documentError.message
                          : String(content.documentError)}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-label="Retry loading document"
                        onClick={content.retryDocument}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap p-3 text-xs">
                      {content.documentContent || "Select a document."}
                    </pre>
                  )}
                </ScrollArea>
              </div>
            )}
          </TabsContent>
          <TabsContent value="notes" className="mt-0 min-h-0 flex-1 overflow-hidden px-4 pb-4">
            {content.loading ? (
              <p className="text-sm text-muted-foreground">Loading Source notes…</p>
            ) : content.loadError ? (
              <SourceContentLoadError error={content.loadError} onRetry={content.reload} />
            ) : (
              <div className="flex h-[min(60vh,480px)] flex-col gap-3">
                {notesError ? (
                  <p className="text-sm text-destructive" role="alert">
                    {notesError}
                  </p>
                ) : null}
                <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
                  <ul className="space-y-2 p-3 text-sm">
                    {content.notes.length === 0 && (
                      <li className="text-muted-foreground">
                        No Source notes yet. Import a domain research pack or write one below.
                      </li>
                    )}
                    {content.notes.map((n) => (
                      <li key={n.id} className="rounded-md border border-border p-2">
                        <div className="flex items-start justify-between gap-2">
                          <strong className="text-foreground">{n.title || "Note"}</strong>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={notesBusy}
                              onClick={() => startEdit(n)}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-destructive"
                              disabled={notesBusy}
                              onClick={() => void removeNote(n.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                          {n.body_markdown}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <div className="space-y-2 rounded-md border border-border p-3">
                  <Field>
                    <FieldLabel className="sr-only" htmlFor="source-note-title">
                      Note title
                    </FieldLabel>
                    <input
                      id="source-note-title"
                      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      placeholder="Note title"
                      value={noteDraftTitle}
                      onChange={(e) => setNoteDraftTitle(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel className="sr-only" htmlFor="source-note-body">
                      Note body
                    </FieldLabel>
                    <textarea
                      id="source-note-body"
                      className="min-h-[88px] w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      placeholder="Markdown notes…"
                      value={noteDraftBody}
                      onChange={(e) => setNoteDraftBody(e.target.value)}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={notesBusy || !noteDraftBody.trim()}
                      onClick={() => void saveNote()}
                    >
                      {editingNoteId != null ? "Update note" : "Add note"}
                    </Button>
                    {editingNoteId != null && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingNoteId(null);
                          setNoteDraftTitle("");
                          setNoteDraftBody("");
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
