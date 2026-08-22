import type { ReviewPart, RoleFilamentRow, SpoolmanSpoolRow } from "../api/engine";
import {
  formatSpoolOptionLabel,
  logPartSpoolPickerHidden,
  partSpoolPickerVisibility,
} from "../lib/spoolPickerUtils";
import {
  buildSpoolmanSpoolId,
  parseSpoolmanFilamentId,
  parseSpoolmanSpoolId,
} from "../lib/spoolmanIds";

const ANY_SPOOL = "__any__";

function selectValue(
  partSpool: string | null | undefined,
  roleSpool: string | null | undefined,
): string {
  const partRef = partSpool ?? null;
  const roleRef = roleSpool ?? null;
  if (partRef === roleRef) return "";
  if (partRef === null && roleRef !== null) return ANY_SPOOL;
  const parsed = partRef ? parseSpoolmanSpoolId(partRef) : null;
  return parsed ? String(parsed.spoolId) : "";
}

type Props = {
  part: Pick<ReviewPart, "id" | "filament_color_id" | "spoolman_spool_id" | "role">;
  roleFilaments: RoleFilamentRow[];
  spools: SpoolmanSpoolRow[];
  spoolsLoading?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  onChange: (partId: number, spoolman_spool_id: string | null) => void;
  className?: string;
};

export default function PartSpoolPicker({
  part,
  roleFilaments,
  spools,
  spoolsLoading,
  disabled,
  hideLabel,
  onChange,
  className,
}: Props) {
  const visibility = partSpoolPickerVisibility(part.filament_color_id, spools, {
    spoolsLoading,
  });
  logPartSpoolPickerHidden(part.id, visibility);

  if (!visibility.show) return null;

  if (visibility.kind === "loading") {
    return (
      <span className={`text-xs text-muted-foreground italic ${className ?? ""}`}>
        Loading spools…
      </span>
    );
  }

  if (visibility.kind === "empty") {
    return (
      <span className={`text-xs text-muted-foreground italic ${className ?? ""}`}>
        No spools for this filament in Spoolman
      </span>
    );
  }

  const filamentParsed = parseSpoolmanFilamentId(part.filament_color_id ?? "")!;
  const filamentSpools = visibility.spools;
  const roleSpool =
    roleFilaments.find((r) => r.role === (part.role || "primary"))?.spoolman_spool_id ?? null;

  const value = selectValue(part.spoolman_spool_id, roleSpool);
  const roleSpoolLabel = roleSpool
    ? (() => {
        const id = parseSpoolmanSpoolId(roleSpool)?.spoolId;
        const match = id != null ? filamentSpools.find((s) => s.id === id) : null;
        return match ? formatSpoolOptionLabel(match) : "Role spool";
      })()
    : "Role default (any spool)";

  const onSelect = (next: string) => {
    if (next === "") {
      onChange(part.id, roleSpool);
      return;
    }
    if (next === ANY_SPOOL) {
      onChange(part.id, null);
      return;
    }
    onChange(
      part.id,
      buildSpoolmanSpoolId(filamentParsed.integrationId, Number(next)),
    );
  };

  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground ${className ?? ""}`}>
      {!hideLabel && <span className="shrink-0 font-medium text-foreground/80">Spool</span>}
      <select
        className="h-7 min-w-[8rem] max-w-[13rem] rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
        value={value}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={`Spool for ${part.id}`}
      >
        <option value="">{roleSpoolLabel}</option>
        {roleSpool != null && (
          <option value={ANY_SPOOL}>Any spool (summary)</option>
        )}
        {filamentSpools.map((spool) => (
          <option key={spool.id} value={String(spool.id)}>
            {formatSpoolOptionLabel(spool)}
          </option>
        ))}
      </select>
    </label>
  );
}
