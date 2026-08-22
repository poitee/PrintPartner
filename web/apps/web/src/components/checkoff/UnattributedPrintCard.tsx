import { useCallback, useEffect, useState } from "react";
import type { UnattributedPrint } from "../../api/engine";
import {
  claimUnattributedPrint,
  dismissUnattributedPrint,
  fetchProfiles,
  type ProfileSummary,
} from "../../api/engine";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
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
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles()
      .then(setProfiles)
      .catch(() => {/* ignore */});
  }, []);

  const hasMatches = print.candidates.some((c) => c.matching_filenames.length > 0);

  const handleClaim = useCallback(async () => {
    const profileId = Number(selectedProfileId);
    if (!Number.isInteger(profileId) || profileId <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await claimUnattributedPrint(print.id, profileId);
      onClaimed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to claim");
      setBusy(false);
    }
  }, [print.id, selectedProfileId, onClaimed]);

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

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardContent className="flex flex-col gap-2 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Unclaimed print detected
            </p>
            <p className="text-xs text-muted-foreground truncate" title={print.filename}>
              {print.host_name} · {shortFilename}
            </p>
          </div>
        </div>

        {print.candidates.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Found on plate:</p>
            <ul className="space-y-0.5">
              {print.candidates.map((c) => (
                <li key={c.stl_basename} className="text-xs">
                  <span className="font-mono">{c.stl_basename}</span>
                  {c.copy_count > 1 && (
                    <span className="text-muted-foreground"> ×{c.copy_count}</span>
                  )}
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
                  <li key={`${c.stl_basename}:${mf}`} className="text-xs font-mono truncate" title={mf}>
                    {mf}
                  </li>
                )),
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground italic">No matches found in library</p>
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

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          {hasMatches && selectedProfileId && (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleClaim()}
              disabled={busy || !selectedProfileId}
            >
              Claim for plan
            </Button>
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
      </CardContent>
    </Card>
  );
}
