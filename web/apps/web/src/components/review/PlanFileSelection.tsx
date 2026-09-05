import { useState } from "react";
import { usePlanReviewQuery } from "../../queries/planReview";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { sourceLabelFromLayer } from "../../lib/reviewParts";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export default function PlanFileSelection({ profileId, disabled }: { profileId: number; disabled: boolean }) {
  const { data, error } = usePlanReviewQuery(profileId, { includeExcluded: true });
  const { setIncluded, setFilesIncluded, draftWorkspace } = usePlanWorkspace();
  const [search, setSearch] = useState("");
  const groups = data?.part_groups ?? [];
  const pendingByKey = new Map(draftWorkspace?.parts.map((part) => [part.part_key, part.included]));
  const isIncluded = (part: { match_key: string; included: boolean }) => pendingByKey.get(part.match_key) ?? part.included;
  const selected = groups.flatMap((group) => group.parts).filter(isIncluded).length;
  const query = search.trim().toLowerCase();
  return (
    <section id="plan-files" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">Files to print</h2>
        <p className="text-xs text-muted-foreground">{selected} selected. Choose files below; these choices only affect this Build.</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">Could not load the files. Reload to try again.</p>}
      <Input aria-label="Find files" placeholder="Find a file or folder…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="max-h-96 space-y-2 overflow-auto">
        {groups.map((group) => {
          const files = group.parts.filter((part) => !query || `${group.folder} ${part.filename} ${sourceLabelFromLayer(group.source_layer)}`.toLowerCase().includes(query));
          if (files.length === 0) return null;
          return (
            <details key={`${group.source_layer}:${group.folder}`} open={query ? true : undefined} className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">{sourceLabelFromLayer(group.source_layer)} / {group.folder === "(root)" ? "Files" : group.folder || "Files"} <span className="text-xs text-muted-foreground">({files.filter(isIncluded).length}/{files.length})</span></summary>
              <div className="mt-2 space-y-1">
                <div className="flex gap-2 py-1">
                  <Button variant="secondary" size="sm" disabled={disabled || files.every(isIncluded)} onClick={() => void setFilesIncluded(files, true).catch(() => {})}>{query ? "Select shown files" : "Select folder"}</Button>
                  <Button variant="ghost" size="sm" disabled={disabled || !files.some(isIncluded)} onClick={() => void setFilesIncluded(files, false).catch(() => {})}>{query ? "Clear shown files" : "Clear folder"}</Button>
                </div>
                {files.map((part) => {
                  return (
                    <label key={part.id} className="flex min-h-10 items-center gap-3 rounded px-2 text-sm hover:bg-muted">
                      <Checkbox checked={isIncluded(part)} disabled={disabled} onCheckedChange={(checked) => void setIncluded(part, checked === true).catch(() => {})} />
                      <span className="break-all">{part.filename}</span>
                    </label>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
      {query && !groups.some((group) => group.parts.some((part) => `${group.folder} ${part.filename} ${sourceLabelFromLayer(group.source_layer)}`.toLowerCase().includes(query))) && <p className="text-sm text-muted-foreground">No matching files.</p>}
    </section>
  );
}
