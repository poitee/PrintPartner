import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_STL_NAMING_PROFILE,
  type SourceSummary,
  type StlNamingProfile,
  type StlNamingProfileOverride,
} from "@print-partner/contracts";
import {
  fetchImportRules,
  saveImportRules,
} from "../../api/endpoints/sources";
import {
  fetchSourceNaming,
  isSourceNamingNotFoundError,
  saveSourceNaming,
  sourceNamingErrorMessage,
} from "../../api/endpoints/sourceNaming";
import { fetchStlNaming, mergeStlNamingProfiles } from "../../api/endpoints/stlNaming";
import { useSourceContent } from "../../queries/sourceContent";
import { sourceNamingDirty } from "../../lib/sourceDetailModel";
import { statusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";
import { StlNamingEditorEmbedded } from "../settings/StlNamingEditor";
import ImportRulesTree from "../ImportRulesTree";
const Preview3D = lazy(() => import("../Preview3D"));
import SourceCardCover from "../SourceCardCover";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { UNCATEGORISED_FILTER } from "./sourceLabels";
import { invalidateProfiles } from "../../queries/profiles";
import { queryClient } from "../../queries/queryClient";

type DetailTab = "docs" | "rules" | "naming";
type DocsSubTab = "synced" | "notes";

type Props = {
  source: SourceSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: DetailTab;
  highlightPath: string | null;
  onTabChange: (tab: DetailTab) => void;
  onHighlightPathChange: (path: string | null) => void;
  busy?: boolean;
  categories?: string[];
  onEdit: (source: SourceSummary) => void;
  onDelete: (source: SourceSummary) => void;
  onAssignCategory?: (source: SourceSummary, category: string | null) => void;
  onSaveRules: () => void;
  runImportScan: (sourceId: number) => void;
};

function SourceDetailsLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-md p-4 text-sm",
        statusTone({ tone: "error", emphasis: "soft" }),
      )}
      role="alert"
    >
      <p>
        Could not load Source details: {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-label="Retry loading Source details"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export default function SourceDetailSheet({
  source,
  open,
  onOpenChange,
  tab,
  highlightPath,
  onTabChange,
  onHighlightPathChange,
  busy = false,
  categories = [],
  onEdit,
  onDelete,
  onAssignCategory,
  onSaveRules,
  runImportScan,
}: Props) {
  const [docsSubTab, setDocsSubTab] = useState<DocsSubTab>("synced");
  const content = useSourceContent(source?.id ?? 0, { enabled: open && source != null });
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [pendingRules, setPendingRules] = useState<string[]>([]);
  const [rulesOwnerId, setRulesOwnerId] = useState<number | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesLoadError, setRulesLoadError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const [globalNaming, setGlobalNaming] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [useDefaults, setUseDefaults] = useState(true);
  const [overrideDraft, setOverrideDraft] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [savedUseDefaults, setSavedUseDefaults] = useState(true);
  const [savedOverride, setSavedOverride] = useState<StlNamingProfileOverride>({});
  const [namingLoadError, setNamingLoadError] = useState<string | null>(null);
  const [namingApiMissing, setNamingApiMissing] = useState(false);
  const [namingOwnerId, setNamingOwnerId] = useState<number | null>(null);
  const [namingLoading, setNamingLoading] = useState(false);
  const [namingSaving, setNamingSaving] = useState(false);
  const [namingNote, setNamingNote] = useState<string | null>(null);
  const rulesGenerationRef = useRef(0);
  const namingGenerationRef = useRef(0);

  const previewProfile = useMemo(
    () => (useDefaults ? globalNaming : overrideDraft),
    [useDefaults, globalNaming, overrideDraft],
  );

  const namingDirty = sourceNamingDirty({
    useDefaults,
    savedUseDefaults,
    overrideDraft,
    globalNaming,
    savedOverride,
  });

  const loadNaming = useCallback(async (sourceId: number) => {
    const generation = namingGenerationRef.current + 1;
    namingGenerationRef.current = generation;
    setNamingOwnerId(null);
    setNamingLoading(true);
    setNamingLoadError(null);
    setNamingApiMissing(false);
    setNamingNote(null);
    try {
      const [global, sourceNaming] = await Promise.all([
        fetchStlNaming(),
        fetchSourceNaming(sourceId),
      ]);
      if (namingGenerationRef.current !== generation) return;
      setGlobalNaming(global);
      setUseDefaults(sourceNaming.use_defaults);
      setSavedUseDefaults(sourceNaming.use_defaults);
      setSavedOverride(sourceNaming.override);
      setOverrideDraft(mergeStlNamingProfiles(global, sourceNaming.override));
      setNamingOwnerId(sourceId);
    } catch (e) {
      if (namingGenerationRef.current !== generation) return;
      if (isSourceNamingNotFoundError(e)) {
        setNamingApiMissing(true);
        setNamingLoadError("Unable to load naming overrides because this Source no longer exists.");
      } else {
        setNamingLoadError(sourceNamingErrorMessage(e));
      }
    } finally {
      if (namingGenerationRef.current === generation) setNamingLoading(false);
    }
  }, []);

  const loadRules = useCallback(async (sourceId: number) => {
    const generation = rulesGenerationRef.current + 1;
    rulesGenerationRef.current = generation;
    setRulesOwnerId(null);
    setRulesLoading(true);
    setPendingRules([]);
    setRulesLoadError(null);
    try {
      const data = await fetchImportRules(sourceId);
      if (rulesGenerationRef.current === generation) {
        setPendingRules(data.rules);
        setRulesOwnerId(sourceId);
      }
    } catch (error) {
      if (rulesGenerationRef.current !== generation) return;
      setPendingRules([]);
      const detail = error instanceof Error ? error.message : String(error);
      setRulesLoadError(`Could not load import rules: ${detail}`);
    } finally {
      if (rulesGenerationRef.current === generation) setRulesLoading(false);
    }
  }, []);

  const sourceId = open ? source?.id ?? null : null;

  useEffect(() => {
    rulesGenerationRef.current += 1;
    namingGenerationRef.current += 1;
    if (sourceId == null) return;
    setDocsSubTab("synced");
    setScanResult(null);
    setNamingSaving(false);
    setActiveNoteId(null);
    setRulesOwnerId(null);
    setPendingRules([]);
    setRulesLoadError(null);
    setNamingOwnerId(null);
    return () => {
      rulesGenerationRef.current += 1;
      namingGenerationRef.current += 1;
    };
  }, [sourceId]);

  useEffect(() => {
    if (sourceId == null) return;
    if (tab === "rules") void loadRules(sourceId);
    if (tab === "naming") void loadNaming(sourceId);
  }, [loadNaming, loadRules, sourceId, tab]);

  useEffect(() => {
    if (!open || !source || content.loading || content.loadError) return;
    if (content.docs.length === 0 && content.notes.length > 0) {
      setDocsSubTab("notes");
      setActiveNoteId(content.notes[0].id);
    }
  }, [content.docs.length, content.loadError, content.loading, content.notes, open, source]);

  const saveRules = async () => {
    if (!source || rulesOwnerId !== source.id || rulesLoading) return;
    const generation = rulesGenerationRef.current + 1;
    rulesGenerationRef.current = generation;
    try {
      await saveImportRules(source.id, pendingRules);
      if (rulesGenerationRef.current !== generation) return;
      runImportScan(source.id);
      onSaveRules();
      setScanResult("Rules saved — import scan started.");
    } catch (e) {
      if (rulesGenerationRef.current !== generation) return;
      setScanResult(e instanceof Error ? e.message : String(e));
    }
  };

  const saveNaming = async () => {
    if (!source || namingOwnerId !== source.id || namingLoading) return;
    const generation = namingGenerationRef.current + 1;
    namingGenerationRef.current = generation;
    setNamingSaving(true);
    setNamingLoadError(null);
    setNamingNote(null);
    try {
      const saved = await saveSourceNaming(
        source.id,
        useDefaults
          ? { use_defaults: true }
          : { use_defaults: false, override: overrideDraft },
      );
      if (namingGenerationRef.current !== generation) return;
      setSavedUseDefaults(saved.use_defaults);
      setSavedOverride(saved.override);
      setOverrideDraft(mergeStlNamingProfiles(globalNaming, saved.override));
      await invalidateProfiles(queryClient);
      if (namingGenerationRef.current !== generation) return;
      setNamingNote("Naming rules saved.");
    } catch (e) {
      if (namingGenerationRef.current !== generation) return;
      const msg = sourceNamingErrorMessage(e);
      setNamingLoadError(msg);
      toast.error(msg);
    } finally {
      if (namingGenerationRef.current === generation) setNamingSaving(false);
    }
  };

  if (!source) return null;

  const activeNote = content.notes.find((note) => note.id === activeNoteId) ?? null;
  const rulesReady = rulesOwnerId === source.id && !rulesLoading;
  const namingReady = namingOwnerId === source.id && !namingLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="left"
        showOverlay={false}
        className="flex w-full max-w-2xl flex-col p-0"
        onInteractOutside={(e) => {
          // Keep docked; nav/Build stay clickable without Escape.
          e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          e.preventDefault();
        }}
      >
        <SheetHeader className="relative border-b p-4 pr-12">
          <SheetClose
            type="button"
            className="absolute right-3 top-3 rounded-sm p-1.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Close source details"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </SheetClose>
          <div className="flex items-start gap-3">
            <SourceCardCover
              sourceId={source.id}
              name={source.name}
              sourceKind={source.source_kind}
              compact
            />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{source.name}</SheetTitle>
              <p className="truncate text-xs text-muted-foreground">{source.url}</p>
              {onAssignCategory ? (
                <div className="mt-2 max-w-[220px] space-y-1">
                  <Label
                    htmlFor={`source-detail-category-${source.id}`}
                    className="text-micro text-muted-foreground"
                  >
                    Category
                  </Label>
                  <Select
                    value={source.category?.trim() || UNCATEGORISED_FILTER}
                    onValueChange={(v) =>
                      onAssignCategory(
                        source,
                        v === UNCATEGORISED_FILTER ? null : v,
                      )
                    }
                    disabled={busy}
                  >
                    <SelectTrigger
                      id={`source-detail-category-${source.id}`}
                      className="h-8 text-xs"
                    >
                      <SelectValue placeholder="Uncategorised" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNCATEGORISED_FILTER}>Uncategorised</SelectItem>
                      {(() => {
                        const current = source.category?.trim() || "";
                        const options =
                          current && !categories.includes(current)
                            ? [current, ...categories]
                            : categories;
                        return options.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ));
                      })()}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="secondary" onClick={() => onEdit(source)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(source)}>
                Delete
              </Button>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as DetailTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="docs">Docs</TabsTrigger>
            <TabsTrigger value="rules">Import files</TabsTrigger>
            <TabsTrigger value="naming">Naming</TabsTrigger>
          </TabsList>

          <TabsContent value="docs" className="mt-0 min-h-0 flex-1 overflow-hidden px-4 pb-4">
            <Tabs
              value={docsSubTab}
              onValueChange={(v) => setDocsSubTab(v as DocsSubTab)}
              className="flex h-[min(60vh,480px)] flex-col gap-2"
            >
              <TabsList className="w-fit">
                <TabsTrigger value="synced">
                  Synced docs{content.docs.length > 0 ? ` (${content.docs.length})` : ""}
                </TabsTrigger>
                <TabsTrigger value="notes">
                  Source notes{content.notes.length > 0 ? ` (${content.notes.length})` : ""}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="synced" className="mt-0 min-h-0 flex-1 overflow-hidden">
                {content.loading ? (
                  <p className="rounded-md border border-border p-4 text-sm text-muted-foreground" role="status">
                    Loading Source details…
                  </p>
                ) : content.loadError ? (
                  <SourceDetailsLoadError error={content.loadError} onRetry={content.reload} />
                ) : content.docs.length === 0 ? (
                  <div className="space-y-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
                    <p>
                      Sync this Source to pull README or PDF files into Synced docs.
                    </p>
                    {content.notes.length > 0 ? (
                      <p>
                        {content.notes.length} Source note{content.notes.length === 1 ? "" : "s"} available.
                        Open the Source notes tab. Empty Synced docs does not mean the import failed.
                      </p>
                    ) : !source.last_synced_at ? (
                      <p>This source has not been synced yet.</p>
                    ) : (
                      <p>No markdown or PDF docs found in the synced tree.</p>
                    )}
                  </div>
                ) : (
                  <div className="grid h-full gap-4 md:grid-cols-[160px_1fr]">
                    <ScrollArea className="h-full rounded-md border border-border">
                      <ul className="p-2 text-sm">
                        {content.docs.map((d) => (
                          <li key={d.path}>
                            <button
                              type="button"
                              className={`w-full rounded px-2 py-1 text-left hover:bg-accent ${content.activeDoc === d.path ? "bg-accent" : ""}`}
                              onClick={() => content.selectDocument(d.path)}
                            >
                              {d.title}
                              {d.kind === "pdf" &&
                              d.extract_status &&
                              d.extract_status !== "ready" ? (
                                <span className="mt-0.5 block text-micro text-muted-foreground">
                                  PDF · {d.extract_status}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                    <ScrollArea className="h-full rounded-md border border-border">
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
              <TabsContent value="notes" className="mt-0 min-h-0 flex-1 overflow-hidden">
                {content.loading ? (
                  <p className="rounded-md border border-border p-4 text-sm text-muted-foreground" role="status">
                    Loading Source details…
                  </p>
                ) : content.loadError ? (
                  <SourceDetailsLoadError error={content.loadError} onRetry={content.reload} />
                ) : content.notes.length === 0 ? (
                  <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
                    No Source notes yet. Import a domain research pack (workflow / pitfalls /
                    quotes) or add Source notes.
                  </p>
                ) : (
                  <div className="grid h-full gap-4 md:grid-cols-[160px_1fr]">
                    <ScrollArea className="h-full rounded-md border border-border">
                      <ul className="p-2 text-sm">
                        {content.notes.map((n) => (
                          <li key={n.id}>
                            <button
                              type="button"
                              className={`w-full rounded px-2 py-1 text-left hover:bg-accent ${activeNoteId === n.id ? "bg-accent" : ""}`}
                              onClick={() => setActiveNoteId(n.id)}
                            >
                              {n.title || "Note"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                    <ScrollArea className="h-full rounded-md border border-border">
                      <pre className="whitespace-pre-wrap p-3 text-xs">
                        {activeNote?.body_markdown || "Select a note."}
                      </pre>
                    </ScrollArea>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent
            value="rules"
            className="mt-0 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-4"
          >
            {rulesLoadError ? (
              <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
                <p className="min-w-0 flex-1">{rulesLoadError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void loadRules(source.id)}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {rulesLoading ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading import rules…
              </p>
            ) : null}
            {highlightPath && (
              <div className="h-40 shrink-0 overflow-hidden rounded-md border border-border">
                <Suspense fallback={<div className="flex items-center justify-center h-40">Loading 3D…</div>}>
                  <Preview3D
                    partId={null}
                    sourceId={source.id}
                    relativePath={highlightPath}
                    preferSource
                    filename={highlightPath.split("/").pop() ?? highlightPath}
                    className="h-full w-full"
                    instructions="sr-only"
                  />
                </Suspense>
              </div>
            )}
            <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
              <div className="p-3">
                <ImportRulesTree
                  projectId={source.id}
                  disabled={busy || !rulesReady}
                  onRulesChange={(rules) => {
                    if (rulesReady) setPendingRules(rules);
                  }}
                  selectedFilePath={highlightPath}
                  onFileSelect={onHighlightPathChange}
                />
              </div>
            </ScrollArea>
            {scanResult && <p className="text-sm text-muted-foreground">{scanResult}</p>}
            <Button onClick={() => void saveRules()} disabled={busy || !rulesReady}>
              Save rules
            </Button>
          </TabsContent>

          <TabsContent
            value="naming"
            className="mt-0 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-4"
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 py-1">
                <p className="text-sm text-muted-foreground">
                  Override how STL paths are parsed for this source. Changes apply on the next{" "}
                  <strong>Rebuild the Plan</strong> after reviewing this source change.
                </p>
                {namingLoadError && <p className="text-sm text-destructive">{namingLoadError}</p>}
                {namingLoading && (
                  <p className="text-sm text-muted-foreground" role="status">
                    Loading naming rules…
                  </p>
                )}
                {namingNote && <p className="text-sm text-muted-foreground">{namingNote}</p>}
                <label
                  className="flex items-center gap-2 text-sm"
                  htmlFor="source-naming-use-defaults"
                >
                  <Checkbox
                    id="source-naming-use-defaults"
                    checked={useDefaults}
                    disabled={!namingReady || namingApiMissing || namingSaving || busy}
                    onCheckedChange={(next) => setUseDefaults(next === true)}
                  />
                  <span>Use app default naming rules</span>
                </label>
                {!useDefaults && (
                  <div>
                    <Label className="mb-2 block text-sm">Source override</Label>
                    <StlNamingEditorEmbedded
                      profile={overrideDraft}
                      onChange={setOverrideDraft}
                      previewProfile={previewProfile}
                      compact
                      disabled={!namingReady || namingApiMissing || namingSaving || busy}
                    />
                  </div>
                )}
                {useDefaults && (
                  <p className="text-sm text-muted-foreground">
                    Using global rules from Settings → STL naming rules.
                  </p>
                )}
              </div>
            </ScrollArea>
            <Button
              onClick={() => void saveNaming()}
              disabled={busy || !namingReady || namingSaving || namingApiMissing || !namingDirty}
            >
              {namingSaving ? "Saving…" : "Save naming"}
            </Button>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
