import { useEffect, useId, useState } from "react";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import { fetchFilamentCatalog, fetchRoleFilaments, type FilamentCatalog, type RoleFilamentRow } from "../../api/endpoints/filaments";
import { usePatchPartMutation } from "../../queries/planReview";
import { catalogColorGroups } from "../FilamentSwatch";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

type ColorChoice = { colorId: string | null; hex: string | null };

export default function PartColorDialog({ part, profileId, onClose }: {
  part: ReviewPart;
  profileId: number;
  onClose: () => void;
}) {
  const id = useId();
  const mutation = usePatchPartMutation(profileId);
  const [options, setOptions] = useState<{ roles: RoleFilamentRow[]; catalog: FilamentCatalog } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState("current");
  const [hex, setHex] = useState(part.filament_hex ?? "#808080");
  useEffect(() => {
    let active = true;
    setLoadError(false);
    void Promise.all([fetchRoleFilaments(profileId), fetchFilamentCatalog()]).then(([roles, catalog]) => {
      if (active) setOptions({ roles, catalog });
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [profileId, attempt]);

  const choices = new Map<string, ColorChoice>();
  options?.roles.forEach((role, index) => choices.set(`build:${index}`, { colorId: role.filament_color_id, hex: role.filament_custom_hex ?? role.filament_hex }));
  const groups = catalogColorGroups(options?.catalog ?? null);
  groups.forEach((group) => group.colors.forEach((color) => choices.set(`catalog:${color.id}`, { colorId: color.id, hex: null })));
  const selected = choices.get(selection);
  const customValid = /^#?[0-9a-fA-F]{6}$/.test(hex.trim());
  const canSave = selection === "custom" ? customValid : Boolean(selected);
  const save = async () => {
    const choice = selection === "custom" ? { colorId: null, hex: hex.trim() } : selected;
    if (!choice) return;
    try {
      await mutation.mutateAsync({ partId: part.id, body: {
        filament_color_id: choice.colorId,
        filament_custom_hex: choice.colorId ? null : choice.hex,
      } });
      onClose();
    } catch { /* The mutation error stays in the dialog for retry. */ }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="min-w-0">
      <DialogHeader>
        <DialogTitle>Change part color</DialogTitle>
        <DialogDescription className="break-all">{part.filename}. This changes only this part, not its {part.role || "primary"} role or the other parts.</DialogDescription>
      </DialogHeader>
      <p className="text-sm">Current color: {part.filament_display || part.filament_hex || "Unassigned"}</p>
      {loadError ? <div role="alert">Could not load colors. <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>Retry</Button></div> : !options ? <p role="status">Loading colors…</p> : null}
      <fieldset disabled={mutation.isPending} className="space-y-3 min-w-0">
        <label htmlFor={`${id}-choice`} className="block text-sm font-medium">Part color</label>
        <select id={`${id}-choice`} className="w-full min-w-0 rounded border bg-background p-2" value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="current">Keep current color</option>
          <optgroup label="Build colors">
            {options?.roles.map((role, index) => <option key={role.role} value={`build:${index}`}>{role.role}: {role.filament_display || role.filament_hex || "Unassigned"}</option>)}
          </optgroup>
          {groups.map((group) => <optgroup key={group.label} label={group.label}>{group.colors.map((color) => <option key={color.id} value={`catalog:${color.id}`}>{color.combo_label || color.display_name}</option>)}</optgroup>)}
          <option value="custom">Custom color…</option>
        </select>
        {selection === "custom" && <div className="space-y-2">
          <label htmlFor={`${id}-hex`} className="block text-sm">Hex color</label>
          <div className="flex gap-2">
            <input aria-label="Pick custom color" type="color" value={customValid ? `#${hex.trim().replace(/^#/, "")}` : "#808080"} onChange={(event) => setHex(event.target.value)} />
            <input id={`${id}-hex`} className="min-w-0 rounded border bg-background p-2" value={hex} onChange={(event) => setHex(event.target.value)} placeholder="#RRGGBB" />
          </div>
          {!customValid && <p role="alert">Enter a six-digit hex color, such as #FF6600.</p>}
        </div>}
        <p className="text-xs text-muted-foreground">Build colors copy the current color of that role. Later changes to that role apply to all its parts.</p>
        {mutation.isError && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : "Could not save this color. Try again."}</p>}
        <div className="flex gap-2"><Button disabled={!canSave || mutation.isPending} onClick={() => void save()}>Save part color</Button><Button variant="outline" onClick={onClose}>Cancel</Button></div>
      </fieldset>
    </DialogContent>
  </Dialog>;
}
