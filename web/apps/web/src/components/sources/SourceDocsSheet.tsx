import { useEffect, useState } from "react";
import {
  createSourceNote,
  deleteSourceNote,
  fetchSourceDocMarkdown,
  fetchSourceDocs,
  fetchSourceNotes,
  fetchSourceReadme,
  updateSourceNote,
  type SourceNote,
} from "../../api/engine";
import { useProfileSelection } from "../../context/ProfileContext";
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

type DocRow = {
  path: string;
  title: string;
  kind?: string;
  extract_status?: string;
};

type Props = {
  sourceId: number;
  sourceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function SourceDocsSheet({
  sourceId,
  sourceName,
  open,
  onOpenChange,
}: Props) {
  const { selectedProfileId } = useProfileSelection();
  const [tab, setTab] = useState<"synced" | "notes">("synced");
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<SourceNote[]>([]);
  const [noteDraftTitle, setNoteDraftTitle] = useState("");
  const [noteDraftBody, setNoteDraftBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [notesBusy, setNotesBusy] = useState(false);
  const [liveReadmeHint, setLiveReadmeHint] = useState<string | null>(null);
  const [syncedEmptyHint, setSyncedEmptyHint] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setActiveDoc(null);
    setDocContent("");
    setLiveReadmeHint(null);
    setSyncedEmptyHint(null);
    void (async () => {
      try {
        const docList = await fetchSourceDocs(sourceId);
        setDocs(docList);
        if (docList.length > 0) {
          const first = docList[0].path;
          setActiveDoc(first);
          const md = await fetchSourceDocMarkdown(sourceId, first);
          setDocContent(md);
        } else {
          // Pre-sync: try live GitHub README
          try {
            const readme = await fetchSourceReadme(sourceId, true);
            if (readme.markdown) {
              setDocs([{ path: "README.md", title: "README (live)", kind: "readme" }]);
              setActiveDoc("README.md");
              setDocContent(readme.markdown);
              setLiveReadmeHint(
                readme.source === "live"
                  ? "Showing live GitHub README (source not synced yet)."
                  : null,
              );
            } else {
              setSyncedEmptyHint(
                "Sync this source to pull README/PDFs from the repository. Curated research and your notes appear under Source notes.",
              );
            }
          } catch {
            setSyncedEmptyHint(
              "Sync this source to pull README/PDFs from the repository. Curated research and your notes appear under Source notes.",
            );
          }
        }
        const noteList = await fetchSourceNotes(sourceId);
        setNotes(noteList);
        if (docList.length === 0 && noteList.length > 0) {
          setSyncedEmptyHint(
            (prev) =>
              prev ??
              "No synced docs yet. Source notes are available in the other tab — Sync this source to pull README/PDFs.",
          );
        }
      } catch {
        setDocs([]);
        setNotes([]);
        setSyncedEmptyHint(
          "Sync this source to pull README/PDFs from the repository. Curated research and your notes appear under Source notes.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open, sourceId]);

  const loadDoc = async (path: string) => {
    setActiveDoc(path);
    try {
      if (path === "README.md" && docs.some((d) => d.title.includes("live"))) {
        const readme = await fetchSourceReadme(sourceId, true);
        setDocContent(readme.markdown);
        return;
      }
      const md = await fetchSourceDocMarkdown(sourceId, path);
      setDocContent(md);
    } catch {
      setDocContent("");
    }
  };

  const saveNote = async () => {
    if (!noteDraftBody.trim()) return;
    setNotesBusy(true);
    try {
      if (editingNoteId != null) {
        const updated = await updateSourceNote(sourceId, editingNoteId, {
          title: noteDraftTitle || "Note",
          body_markdown: noteDraftBody,
        });
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      } else {
        const created = await createSourceNote(sourceId, {
          title: noteDraftTitle || "Note",
          body_markdown: noteDraftBody,
          profile_id:
            selectedProfileId != null && selectedProfileId > 0
              ? selectedProfileId
              : null,
        });
        setNotes((prev) => [...prev, created]);
      }
      setNoteDraftTitle("");
      setNoteDraftBody("");
      setEditingNoteId(null);
    } finally {
      setNotesBusy(false);
    }
  };

  const startEdit = (note: SourceNote) => {
    setEditingNoteId(note.id);
    setNoteDraftTitle(note.title);
    setNoteDraftBody(note.body_markdown);
  };

  const removeNote = async (noteId: number) => {
    setNotesBusy(true);
    try {
      await deleteSourceNote(sourceId, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      if (editingNoteId === noteId) {
        setEditingNoteId(null);
        setNoteDraftTitle("");
        setNoteDraftBody("");
      }
    } finally {
      setNotesBusy(false);
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
              Synced docs{docs.length > 0 ? ` (${docs.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="notes">
              Source notes{notes.length > 0 ? ` (${notes.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="synced" className="mt-0 min-h-0 flex-1 overflow-hidden px-4 pb-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading docs…</p>
            ) : docs.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {syncedEmptyHint ??
                    "Sync this source to pull README/PDFs from the repository."}
                </p>
                {notes.length > 0 ? (
                  <p>
                    {notes.length} Source note{notes.length === 1 ? "" : "s"} available — switch
                    tabs to read them.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[140px_1fr]">
                <ScrollArea className="h-[min(60vh,420px)] rounded-md border border-border">
                  <ul className="p-2 text-sm">
                    {docs.map((d) => (
                      <li key={d.path}>
                        <button
                          type="button"
                          className={`w-full rounded px-2 py-1 text-left hover:bg-accent ${activeDoc === d.path ? "bg-accent" : ""}`}
                          onClick={() => void loadDoc(d.path)}
                        >
                          {d.title}
                          {d.kind === "pdf" ? (
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">
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
                  {liveReadmeHint && (
                    <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                      {liveReadmeHint}
                    </p>
                  )}
                  <pre className="whitespace-pre-wrap p-3 text-xs">
                    {docContent || "Select a document."}
                  </pre>
                </ScrollArea>
              </div>
            )}
          </TabsContent>
          <TabsContent value="notes" className="mt-0 min-h-0 flex-1 overflow-hidden px-4 pb-4">
            <div className="flex h-[min(60vh,480px)] flex-col gap-3">
              <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
                <ul className="space-y-2 p-3 text-sm">
                  {notes.length === 0 && (
                    <li className="text-muted-foreground">
                      No Source notes yet. Import a domain research pack or write one below.
                    </li>
                  )}
                  {notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border p-2">
                      <div className="flex items-start justify-between gap-2">
                        <strong className="text-foreground">{n.title || "Note"}</strong>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
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
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
