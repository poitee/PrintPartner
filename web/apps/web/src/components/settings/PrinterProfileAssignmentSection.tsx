import { useCallback, useEffect, useState } from "react";
import {
  fetchPrinterProfileAssignment,
  fetchSlicerProfileOptions,
  formatSyncTime,
  savePrinterProfileAssignment,
  type PrinterMachine,
  type PrinterProfileAssignment,
  type SlicerProfileOptions,
} from "../../api/engine";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { cn } from "../../lib/utils";

type Props = {
  printer: PrinterMachine;
  engineReady: boolean;
  disabled?: boolean;
};

const NONE = "__none__";

export default function PrinterProfileAssignmentSection({
  printer,
  engineReady,
  disabled = false,
}: Props) {
  const [assignment, setAssignment] = useState<PrinterProfileAssignment | null>(null);
  const [options, setOptions] = useState<SlicerProfileOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [profileSource, setProfileSource] = useState<"assigned" | "auto_match">("auto_match");
  const [machineProfileId, setMachineProfileId] = useState<number | null>(null);
  const [filamentSlots, setFilamentSlots] = useState<
    Array<{ slot_index: number; filament_profile_id: number | null }>
  >([]);

  const applyAssignment = useCallback((row: PrinterProfileAssignment) => {
    setAssignment(row);
    setProfileSource(row.profile_source);
    setMachineProfileId(row.machine_profile_id);
    setFilamentSlots(row.filament_slots);
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!engineReady) {
      setAssignment(null);
      setOptions(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    void Promise.all([
      fetchPrinterProfileAssignment(printer.id),
      fetchSlicerProfileOptions(),
    ])
      .then(([row, opts]) => {
        if (cancelled) return;
        applyAssignment(row);
        setOptions(opts);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engineReady, printer.id, applyAssignment]);

  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await savePrinterProfileAssignment(printer.id, {
        profile_source: profileSource,
        machine_profile_id: machineProfileId,
        filament_slots: filamentSlots,
      });
      applyAssignment(saved);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const assignedMode = profileSource === "assigned";
  const lastSynced = assignment?.last_synced_at
    ? formatSyncTime(assignment.last_synced_at)
    : "Not synced";

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border/80 bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Slicer profiles
          </p>
          <p className="text-xs text-muted-foreground">
            Last synced: {lastSynced}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!engineReady || disabled || saving || !dirty}
          onClick={() => void onSave()}
        >
          {saving ? "Saving…" : "Save profiles"}
        </Button>
      </div>

      {loadError && <p className="text-xs text-destructive">{loadError}</p>}
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <label className="block text-xs">
        <span className="mb-1 block text-muted-foreground">Profile routing</span>
        <Select
          value={profileSource}
          onValueChange={(v) => {
            setProfileSource(v as "assigned" | "auto_match");
            setDirty(true);
          }}
          disabled={!engineReady || disabled || saving}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto_match">Auto-match by name</SelectItem>
            <SelectItem value="assigned">Use assigned profiles</SelectItem>
          </SelectContent>
        </Select>
        {!assignedMode && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Saves name matching as a preference for future integrations.
          </p>
        )}
      </label>

      {assignedMode && (
        <>
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">Machine profile</span>
            <Select
              value={machineProfileId != null ? String(machineProfileId) : NONE}
              onValueChange={(v) => {
                setMachineProfileId(v === NONE ? null : Number(v));
                setDirty(true);
              }}
              disabled={!engineReady || disabled || saving || !options}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Choose machine profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not assigned</SelectItem>
                {(options?.printers ?? []).map((row) => (
                  <SelectItem key={row.id} value={String(row.id)}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            {filamentSlots.map((slot) => (
              <label key={slot.slot_index} className="block text-xs">
                <span className="mb-1 block text-muted-foreground">
                  Slot {slot.slot_index} filament profile
                </span>
                <Select
                  value={
                    slot.filament_profile_id != null
                      ? String(slot.filament_profile_id)
                      : NONE
                  }
                  onValueChange={(v) => {
                    const nextId = v === NONE ? null : Number(v);
                    setFilamentSlots((prev) =>
                      prev.map((s) =>
                        s.slot_index === slot.slot_index
                          ? { ...s, filament_profile_id: nextId }
                          : s,
                      ),
                    );
                    setDirty(true);
                  }}
                  disabled={!engineReady || disabled || saving || !options}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Not assigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not assigned</SelectItem>
                    {(options?.filaments ?? []).map((row) => (
                      <SelectItem key={row.id} value={String(row.id)}>
                        {row.name}
                        {row.material_type ? ` (${row.material_type})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>

          {(assignment?.compatible_processes.length ?? 0) > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">
                Compatible process profiles
              </p>
              <div className="flex flex-wrap gap-1.5">
                {assignment!.compatible_processes.map((p) => (
                  <span
                    key={p.id}
                    className={cn(
                      "inline-flex rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground",
                    )}
                  >
                    {p.name}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Compatible processes are reference metadata. Accepted Plate export and handoff do
                not choose a process profile.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
