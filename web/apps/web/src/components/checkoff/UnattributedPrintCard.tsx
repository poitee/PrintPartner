import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { ProfileSummary, UnattributedPrint } from "@print-partner/contracts";
import {
  claimUnattributedPrint,
  dismissUnattributedPrint,
} from "../../api/endpoints/checkoff";
import { fetchProfiles } from "../../api/endpoints/plans";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Props = {
  print: UnattributedPrint;
  onClaimed?: () => void;
  onDismissed?: () => void;
};

export default function UnattributedPrintCard({ print, onClaimed, onDismissed }: Props) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedStlBasenames, setSelectedStlBasenames] = useState<Set<string>>(
    () => new Set(print.candidates.map((candidate) => candidate.stl_basename)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles()
      .then(setProfiles)
      .catch(() => {/* ignore */});
  }, []);

  const hasMatches = print.candidates.some((c) => c.matching_filenames.length > 0);

  const handleClaim = useCallback(async (scope: "whole_plate" | "selected_files") => {
    const profileId = Number(selectedProfileId);
    if (!Number.isInteger(profileId) || profileId <= 0) return;
    const selected = [...selectedStlBasenames];
    if (scope === "selected_files" && selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await claimUnattributedPrint(
        print.id,
        profileId,
        scope === "selected_files" ? { selected_stl_basenames: selected } : undefined,
      );
      onClaimed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to claim");
      setBusy(false);
    }
  }, [print.id, selectedProfileId, selectedStlBasenames, onClaimed]);

  const handleDismiss = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await dismissUnattributedPrint(print.id);
      onDismissed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to dismiss");
      setBusy(false);
    }
  }, [print.id, onDismissed]);

  const shortFilename = print.filename.split("/").pop() ?? print.filename;

  const candidateCount = print.candidates.length;
  const selectedCount = selectedStlBasenames.size;

  const toggleCandidate = (stlBasename: string, checked: boolean) => {
    setSelectedStlBasenames((current) => {
      const next = new Set(current);
      if (checked) next.add(stlBasename);
      else next.delete(stlBasename);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-warning/30 bg-warning-soft px-3 py-1.5 text-left text-xs text-warning shadow-sm transition-colors hover:bg-warning-soft/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium">Unclaimed print detected</span>
        <span className="min-w-0 truncate text-muted-foreground" title={print.filename}>
          {print.host_name} · {shortFilename}
        </span>
        {candidateCount > 0 && (
          <span className="shrink-0 text-muted-foreground">
            · {candidateCount} file{candidateCount === 1 ? "" : "s"}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {expanded && (
        <div
          id={detailsId}
          className="max-w-2xl rounded-lg border border-warning/25 bg-card p-3 shadow-sm"
        >
          <div className="flex flex-col gap-2">
            {print.candidates.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Found on plate:</p>
                <ul className="space-y-0.5">
                  {print.candidates.map((c) => (
                    <li key={c.stl_basename} className="text-xs">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedStlBasenames.has(c.stl_basename)}
                          onChange={(event) => toggleCandidate(c.stl_basename, event.target.checked)}
                          disabled={busy}
                        />
                        <span className="font-mono">{c.stl_basename}</span>
                        {c.copy_count > 1 && (
                          <span className="text-muted-foreground"> ×{c.copy_count}</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Matches in library:</p>
              {hasMatches ? (
                <ul className="space-y-0.5">
                  {print.candidates.flatMap((c) =>
                    c.matching_filenames.map((mf) => (
                      <li
                        key={`${c.stl_basename}:${mf}`}
                        className="truncate font-mono text-xs"
                        title={mf}
                      >
                        {mf}
                      </li>
                    )),
                  )}
                </ul>
              ) : (
                <p className="text-xs italic text-muted-foreground">No matches found in library</p>
              )}
            </div>

            {hasMatches && profiles.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Which plan is this for?</p>
                <Select
                  value={selectedProfileId}
                  onValueChange={setSelectedProfileId}
                  disabled={busy}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select a plan…" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)} className="text-xs">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              {hasMatches && selectedProfileId && (
                <>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void handleClaim("whole_plate")}
                    disabled={busy || !selectedProfileId}
                  >
                    Claim whole plate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => void handleClaim("selected_files")}
                    disabled={busy || !selectedProfileId || selectedCount === 0}
                  >
                    Claim selected files
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => void handleDismiss()}
                disabled={busy}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
