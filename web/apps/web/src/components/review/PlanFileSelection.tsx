import { useState } from "react";
import { usePlanReviewQuery } from "../../queries/planReview";
import { usePlanLayersQuery } from "../../queries/planLayers";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { StlTreeNode } from "../../api/importRulesTree";
import { TreeRows } from "../ImportRulesTree";
import { Input } from "../ui/input";
import { planFileIdentity } from "../../hooks/usePlanFileChoices";

function fileTree(parts: readonly ReviewPart[], included: (part: ReviewPart) => boolean): StlTreeNode[] {
  const roots: StlTreeNode[] = [];
  for (const part of parts) {
    const folders = part.relative_path.split("/").slice(0, -1);
    let children = roots;
    let path = "";
    for (const name of folders) {
      path = path ? `${path}/${name}` : name;
      let folder = children.find((node) => node.kind === "folder" && node.path === path);
      if (!folder) {
        folder = { kind: "folder", name, path, check_state: "unchecked", children: [] };
        children.push(folder);
      }
      if (folder.kind === "folder") children = folder.children;
    }
    children.push({ kind: "file", name: part.filename, path: part.relative_path, checked: included(part) });
  }
  return roots;
}

export default function PlanFileSelection({ profileId, disabled }: { profileId: number; disabled: boolean }) {
  const { data, error } = usePlanReviewQuery(profileId, { includeExcluded: true });
  const layers = usePlanLayersQuery(profileId);
  const { setFilesIncluded, draftWorkspace, pendingFileChoices } = usePlanWorkspace();
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = data?.part_groups ?? [];
  const pendingByKey = new Map(draftWorkspace?.parts.map((part) => [part.part_key, part.included]));
  const isIncluded = (part: ReviewPart) => pendingFileChoices?.get(planFileIdentity(part))?.included ?? pendingByKey.get(part.match_key) ?? part.included;
  const selected = groups.flatMap((group) => group.parts).filter(isIncluded).length;
  const query = search.trim().toLowerCase();
  return (
    <section id="plan-files" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">Files to print</h2>
        <p className="text-xs text-muted-foreground">{selected} selected. Choices apply only to this Build.</p>
      </div>
      {(error || layers.error) && <p role="alert">Could not load the files and sources. Reload to try again.</p>}
      <Input aria-label="Find files" placeholder="Find a file or folder…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="max-h-[36rem] space-y-3 overflow-auto">
        {layers.data?.filter((layer) => layer.project_id != null).map((layer) => {
          const sourceLayer = `${layer.layer_type}:${layer.project_name}`;
          const all = groups.flatMap((group) => group.parts).filter((part) => part.source_layer === sourceLayer);
          const files = all.filter((part) => `${layer.project_name} ${part.relative_path}`.toLowerCase().includes(query));
          if (query && files.length === 0 && !layer.project_name?.toLowerCase().includes(query)) return null;
          const prefix = `${layer.id}:`;
          return (
            <section key={layer.id} className="rounded-md border border-border p-3" aria-label={layer.project_name ?? "Source"}>
              <h3 className="mb-2 text-sm font-semibold">{layer.project_name}</h3>
              {all.length === 0 ? (
                <p className="text-sm text-muted-foreground">No printable files from this source are available in Plan. Check its files and repository URL in the <a className="underline" href="/library">Source Library</a>, then sync on <a className="underline" href={`/sources?profile=${profileId}`}>Sources</a>.</p>
              ) : (
                <ul className="list-none p-0">
                  <TreeRows nodes={fileTree(files, isIncluded)} depth={0} filter="" sortBy="name" variant="inline"
                    projectId={layer.project_id ?? layer.id} disabled={disabled}
                    collapsedFolders={query ? new Set() : new Set([...collapsed].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))}
                    onToggleFolderExpand={(path) => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(prefix + path)) next.delete(prefix + path); else next.add(prefix + path);
                      return next;
                    })}
                    onToggleFile={(path, checked) => void setFilesIncluded(files.filter((part) => part.relative_path === path), checked).catch(() => {})}
                    onFileSelect={(path) => {
                      const part = files.find((file) => file.relative_path === path);
                      if (part) void setFilesIncluded([part], !isIncluded(part)).catch(() => {});
                    }}
                    onToggleFolder={(path, checked) => void setFilesIncluded(files.filter((part) => part.relative_path.startsWith(`${path}/`)), checked).catch(() => {})}
                  />
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
