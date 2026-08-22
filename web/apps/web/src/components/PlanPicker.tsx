import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";
import { toast } from "sonner";
import { buildRoute, isPlansPath } from "../lib/routes";
import { partitionPlanPickerGroups } from "../lib/planPickerGroups";
import { cn } from "../lib/utils";
import { usePlanActions } from "../context/PlanActionsContext";
import { useProfileSelection } from "../context/ProfileContext";
import {
  useArchiveProfileMutation,
  useCreateProfileMutation,
  useDeleteProfileMutation,
  useDuplicateProfileMutation,
  useTouchProfileLastUsedMutation,
  useUpdateProfileMutation,
} from "../queries/profiles";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import VariantDimensionDialog from "./VariantDimensionDialog";

type Props = {
  disabled?: boolean;
  className?: string;
  /** Icon-only trigger for the collapsed spine rail. */
  compact?: boolean;
};

type SwitchPrompt = {
  targetId: number;
  targetName: string;
};

/** Spine/mobile plan switcher (CRUD dialogs opened via PlanActionsContext). */
export default function PlanPicker({
  disabled,
  className,
  compact = false,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { profiles, selectedProfileId, setSelectedProfileId, loading } =
    useProfileSelection();
  const createMutation = useCreateProfileMutation();
  const updateMutation = useUpdateProfileMutation();
  const deleteMutation = useDeleteProfileMutation();
  const duplicateMutation = useDuplicateProfileMutation();
  const archiveMutation = useArchiveProfileMutation();
  const touchMutation = useTouchProfileLastUsedMutation();
  const {
    registerOpenCreate,
    registerOpenRename,
    registerOpenDuplicate,
    registerOpenDelete,
    registerOpenArchive,
  } = usePlanActions();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [actionTargetId, setActionTargetId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateClearCheckoff, setDuplicateClearCheckoff] = useState(false);
  const [switchPrompt, setSwitchPrompt] = useState<SwitchPrompt | null>(null);
  const [variantPlanId, setVariantPlanId] = useState<number | null>(null);

  const selected = profiles.find((p) => p.id === selectedProfileId);
  const actionTarget =
    actionTargetId != null
      ? profiles.find((p) => p.id === actionTargetId)
      : selected;
  const selectedArchived = Boolean(selected?.archived_at);
  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    duplicateMutation.isPending ||
    archiveMutation.isPending;

  const groups = useMemo(
    () => partitionPlanPickerGroups(profiles, selectedProfileId, { search }),
    [profiles, selectedProfileId, search],
  );

  useEffect(() => {
    if (actionTargetId != null) return;
    setRenameName(selected?.name ?? "");
  }, [actionTargetId, selected?.id, selected?.name]);

  useEffect(() => {
    registerOpenCreate(() => setCreateOpen(true));
    return () => registerOpenCreate(null);
  }, [registerOpenCreate]);

  useEffect(() => {
    registerOpenRename((planId) => {
      const id = planId ?? selectedProfileId;
      if (id == null) return;
      const plan = profiles.find((p) => p.id === id);
      setActionTargetId(id);
      setRenameName(plan?.name ?? "");
      setRenameOpen(true);
    });
    return () => registerOpenRename(null);
  }, [registerOpenRename, selectedProfileId, profiles]);

  useEffect(() => {
    registerOpenDuplicate((planId) => {
      const id = planId ?? selectedProfileId;
      if (id == null) return;
      const plan = profiles.find((p) => p.id === id);
      setActionTargetId(id);
      setDuplicateName(`${plan?.name ?? "Plan"} (copy)`);
      setDuplicateClearCheckoff(false);
      setDuplicateOpen(true);
    });
    return () => registerOpenDuplicate(null);
  }, [registerOpenDuplicate, selectedProfileId, profiles]);

  useEffect(() => {
    registerOpenDelete((planId) => {
      const id = planId ?? selectedProfileId;
      if (id == null) return;
      setActionTargetId(id);
      setDeleteOpen(true);
    });
    return () => registerOpenDelete(null);
  }, [registerOpenDelete, selectedProfileId]);

  useEffect(() => {
    registerOpenArchive((planId) => {
      const id = planId ?? selectedProfileId;
      if (id == null) return;
      setActionTargetId(id);
      setArchiveOpen(true);
    });
    return () => registerOpenArchive(null);
  }, [registerOpenArchive, selectedProfileId]);

  const closeActionDialog = () => {
    setActionTargetId(null);
  };

  const shouldAskToSwitch = () => {
    if (selectedProfileId == null) return false;
    return (selected?.part_count ?? 0) > 0;
  };

  const activatePlan = (id: number) => {
    setSelectedProfileId(id);
    touchMutation.mutate(id);
    navigate(buildRoute(id), { replace: true });
  };

  const selectPlan = (id: number) => {
    setSelectedProfileId(id);
    touchMutation.mutate(id);
    setOpen(false);
    setSearch("");
  };

  const offerSwitchOrActivate = (targetId: number, targetName: string) => {
    if (shouldAskToSwitch() && selectedProfileId !== targetId) {
      setSwitchPrompt({ targetId, targetName });
      return;
    }
    activatePlan(targetId);
    toast.success(`Created Build “${targetName}”`);
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await createMutation.mutateAsync(name);
      setNewName("");
      setCreateOpen(false);
      // Show variant dimension picker if base source declares variant_dimensions
      setVariantPlanId(created.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onVariantDone = () => {
    if (variantPlanId == null) return;
    const id = variantPlanId;
    setVariantPlanId(null);
    // find the name from profiles or fall back to empty string
    const name = profiles.find((p) => p.id === id)?.name ?? "";
    offerSwitchOrActivate(id, name);
  };

  const onRename = async () => {
    if (actionTargetId == null) return;
    const name = renameName.trim();
    if (!name) return;
    try {
      await updateMutation.mutateAsync({ id: actionTargetId, name });
      setRenameOpen(false);
      closeActionDialog();
      toast.success(`Renamed Build to “${name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDuplicate = async () => {
    if (actionTargetId == null) return;
    const name = duplicateName.trim();
    if (!name) return;
    const sourceWasSelected = actionTargetId === selectedProfileId;
    try {
      const copy = await duplicateMutation.mutateAsync({
        id: actionTargetId,
        name,
        clearCheckoff: duplicateClearCheckoff,
      });
      setDuplicateOpen(false);
      closeActionDialog();
      // Only move the spine selection when the duplicated plan was the
      // active one — duplicating a different row shouldn't silently switch
      // what's selected.
      if (sourceWasSelected) {
        // On /plans keep the list in view; elsewhere open the copy on Plan.
        if (isPlansPath(location.pathname)) {
          setSelectedProfileId(copy.id);
          touchMutation.mutate(copy.id);
        } else {
          activatePlan(copy.id);
        }
      }
      toast.success(`Duplicated Build “${name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDelete = async () => {
    if (actionTargetId == null || !actionTarget) return;
    const deletedName = actionTarget.name;
    try {
      await deleteMutation.mutateAsync(actionTargetId);
      setDeleteOpen(false);
      closeActionDialog();
      toast.success(`Deleted Build “${deletedName}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmArchive = async () => {
    if (actionTargetId == null || !actionTarget) return;
    try {
      await archiveMutation.mutateAsync(actionTargetId);
      setArchiveOpen(false);
      closeActionDialog();
      toast.success(`Archived “${actionTarget.name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const labelName = selected?.name ?? null;
  const label =
    selected != null
      ? `${selected.name} (${selected.part_count} parts)`
      : profiles.length === 0
        ? "New Build"
        : "Select Build";

  const renderPlanItem = (
    p: { id: number; name: string; archived_at: string | null },
    opts?: { showArchivedHint?: boolean },
  ) => (
    <CommandItem
      key={p.id}
      value={`${p.name} ${p.id}`}
      onSelect={() => selectPlan(p.id)}
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4",
          selectedProfileId === p.id ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="truncate">{p.name}</span>
      {opts?.showArchivedHint && p.archived_at ? (
        <span className="ml-2 shrink-0 text-xs text-muted-foreground">
          Archived
        </span>
      ) : null}
    </CommandItem>
  );

  return (
    <>
      {profiles.length === 0 ? (
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon" : "default"}
          disabled={disabled || loading || busy}
          className={cn(
            compact
              ? "text-muted-foreground"
              : "min-w-0 justify-between font-normal",
            className,
          )}
          onClick={() => setCreateOpen(true)}
          aria-label="New Build"
        >
          {compact ? (
            <Plus className="h-4 w-4" />
          ) : (
            <>
              <span className="truncate">{label}</span>
              <Plus className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </>
          )}
        </Button>
      ) : (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant={compact ? "ghost" : "outline"}
              size={compact ? "icon" : "default"}
              role="combobox"
              aria-expanded={open}
              aria-label="Select Build"
              disabled={disabled || loading || busy}
              className={cn(
                compact
                  ? "text-muted-foreground"
                  : "min-w-0 justify-between font-normal",
                className,
              )}
            >
              {compact ? (
                <Layers className="h-4 w-4" />
              ) : (
                <>
                  <span className="min-w-0 truncate">
                    {labelName != null ? (
                      <>
                        <span>{labelName}</span>
                        {selectedArchived ? (
                          <span className="text-muted-foreground">
                            {" "}
                            Archived
                          </span>
                        ) : null}
                        <span className="text-muted-foreground">
                          {" "}
                          ({selected!.part_count} parts)
                        </span>
                      </>
                    ) : (
                      label
                    )}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[min(100vw-2rem,320px)] p-0"
            align={compact ? "start" : "end"}
            side={compact ? "right" : "bottom"}
          >
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search builds…"
                value={search}
                onValueChange={setSearch}
              />
              <CommandList>
                <CommandEmpty>No builds found.</CommandEmpty>
                {groups.active.length > 0 ? (
                  <CommandGroup heading="Active">
                    {groups.active.map((p) =>
                      renderPlanItem(p, { showArchivedHint: true }),
                    )}
                  </CommandGroup>
                ) : null}
                {groups.recent.length > 0 ? (
                  <CommandGroup heading="Recent">
                    {groups.recent.map((p) => renderPlanItem(p))}
                  </CommandGroup>
                ) : null}
                {groups.archived.length > 0 ? (
                  <CommandGroup heading="Archived">
                    {groups.archived.map((p) => renderPlanItem(p))}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Build</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="plan-create-name">Build name</Label>
            <Input
              id="plan-create-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void onCreate()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || busy}
              onClick={() => void onCreate()}
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameOpen}
        onOpenChange={(next) => {
          setRenameOpen(next);
          if (!next) closeActionDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Build</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="plan-rename-name">Name</Label>
            <Input
              id="plan-rename-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void onRename()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setRenameOpen(false);
                closeActionDialog();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!renameName.trim() || busy}
              onClick={() => void onRename()}
            >
              Rename
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={duplicateOpen}
        onOpenChange={(next) => {
          setDuplicateOpen(next);
          if (!next) closeActionDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Duplicate Build</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="plan-dup-name">Name</Label>
            <Input
              id="plan-dup-name"
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
            />
          </div>
          <label className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                Clear checkoff progress
              </span>
              <span className="block text-xs text-muted-foreground">
                Start the copy with nothing marked printed.
              </span>
            </span>
            <Switch
              checked={duplicateClearCheckoff}
              onCheckedChange={setDuplicateClearCheckoff}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDuplicateOpen(false);
                closeActionDialog();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!duplicateName.trim() || busy}
              onClick={() => void confirmDuplicate()}
            >
              Duplicate
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next);
          if (!next) closeActionDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Build?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete “{actionTarget?.name}” and all its parts, layers, and print
            settings?
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteOpen(false);
                closeActionDialog();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveOpen}
        onOpenChange={(next) => {
          setArchiveOpen(next);
          if (!next) closeActionDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Archive Build?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Archive “{actionTarget?.name}”? It stays in the picker as a
            template.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setArchiveOpen(false);
                closeActionDialog();
              }}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void confirmArchive()}>
              Archive
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={switchPrompt != null}
        onOpenChange={(o) => !o && setSwitchPrompt(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Switch to this Build?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {switchPrompt && selected
              ? `Created “${switchPrompt.targetName}”. Switch now or stay on “${selected.name}”?`
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSwitchPrompt(null)}>
              Stay on current
            </Button>
            <Button
              onClick={() => {
                if (switchPrompt) activatePlan(switchPrompt.targetId);
                setSwitchPrompt(null);
              }}
            >
              Switch Build
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {variantPlanId != null && (
        <VariantDimensionDialog profileId={variantPlanId} onDone={onVariantDone} />
      )}
    </>
  );
}
