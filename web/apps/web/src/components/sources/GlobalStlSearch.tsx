import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchSourceStls, type StlSearchHit } from "../../api/engine";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";

type Props = {
  engineReady: boolean;
  hasSyncedSources: boolean;
  onSelectHit: (hit: StlSearchHit) => void;
  initialQuery?: string;
  autoFocus?: boolean;
};

export default function GlobalStlSearch({
  engineReady,
  hasSyncedSources,
  onSelectHit,
  initialQuery = "",
  autoFocus = false,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<StlSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!engineReady) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchSourceStls(q, 50)
        .then((body) => {
          setResults(body.results);
          setError(null);
        })
        .catch((e) => {
          setResults([]);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, engineReady]);

  const showPanel = query.trim().length >= 2;

  return (
    <div className="space-y-1">
      <Label htmlFor="global-stl-search" className="text-xs text-muted-foreground">
        Search all repos for a part
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="global-stl-search"
          className="min-h-10 pl-9 text-base sm:text-sm"
          placeholder="Filename or path (e.g. klicky)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!engineReady}
        />
      </div>
      {showPanel && (
        <div className="rounded-md border border-border bg-card shadow-sm">
          {!hasSyncedSources ? (
            <p className="p-3 text-sm text-muted-foreground">
              Sync repos first to search across STL files.
            </p>
          ) : searching ? (
            <p className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : error ? (
            <p className="p-3 text-sm text-destructive">{error}</p>
          ) : results.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matches for “{query.trim()}”.</p>
          ) : (
            <ScrollArea className="max-h-56">
              <ul className="p-1">
                {results.map((hit) => (
                  <li key={`${hit.source_id}-${hit.relative_path}`}>
                    <button
                      type="button"
                      className={cn(
                        "flex min-h-11 w-full flex-col gap-0.5 rounded-sm px-2 py-2.5 text-left text-sm hover:bg-accent",
                      )}
                      onClick={() => onSelectHit(hit)}
                    >
                      <span className="font-medium text-foreground">{hit.filename}</span>
                      <span className="text-xs text-muted-foreground">
                        {hit.source_name} · {hit.relative_path}
                      </span>
                      {hit.category && (
                        <Badge variant="muted" className="mt-0.5 w-fit">
                          {hit.category}
                        </Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}
