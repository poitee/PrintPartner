import { useCallback, useEffect, useRef, useState } from "react";
import type { ManifestSelections } from "@print-partner/contracts";
import {
  savePlanKitManifest,
  type KitManifest,
} from "../api/endpoints/planManifests";
import type { BuildSaveFlushMode } from "../context/BuildSaveFlushContext";
import type { AutosaveStatus } from "../lib/autosaveStatus";
import { KIT_MANIFEST_SAVED_CLEAR_MS, selectionsEqual } from "../lib/kitManifestSave";
import {
  clearFailedAuxiliarySave,
  retainFailedAuxiliarySave,
} from "../lib/planAuxiliarySaveIntent";

type Options = {
  profileId: number;
  pendingSelections: ManifestSelections;
  savedSelections: ManifestSelections;
  loaded: boolean;
  userEdited: boolean;
  disabled: boolean;
  baseKit: KitManifest | null;
  onPersisted?: (kit: KitManifest) => Promise<void>;
  onSaved: (kit: KitManifest) => void | Promise<void>;
  onRegisterFlush?: (profileId: number, flush: (mode: BuildSaveFlushMode) => Promise<void>) => () => void;
};

type ProfileSaveState = {
  profileId: number;
  inFlight: Promise<void> | null;
  queuedSelections: ManifestSelections | null;
  pendingSelections: ManifestSelections;
  savedSelections: ManifestSelections;
  baseKit: KitManifest | null;
  loaded: boolean;
  disabled: boolean;
  lastPendingSelectionsProp: ManifestSelections;
  lastSavedSelectionsProp: ManifestSelections;
  lastBaseKitProp: KitManifest | null;
  pendingConfirmation: KitManifest | null;
  retainedFailedKit: KitManifest | null;
};

// KitManifestOptions remounts per Build, so a refused PUT outlives the editor that sent it.
// The editor mounted for that Build adopts the retained kit and owns its retry and status.
const retainedFailedKitByProfile = new Map<number, KitManifest>();
const mountedFlushByProfile = new Map<
  number,
  { owner: ProfileSaveState; flush: (mode: BuildSaveFlushMode) => Promise<void> }
>();

async function retryMountedManifestSave(profileId: number): Promise<void> {
  const mounted = mountedFlushByProfile.get(profileId);
  if (!mounted) throw new Error("Kit manifest autosave is unavailable");
  await mounted.flush("retry");
}

/** Selections of a refused manifest save, so a remounted editor shows what Retry sends. */
export function retainedFailedManifestSelections(profileId: number): ManifestSelections | null {
  return retainedFailedKitByProfile.get(profileId)?.selections ?? null;
}

export function resetKitManifestAutosaveForTests(): void {
  retainedFailedKitByProfile.clear();
  mountedFlushByProfile.clear();
}

function kitFromState(
  saveState: ProfileSaveState,
  selectionsToSave: ManifestSelections,
): KitManifest {
  const kitBase = saveState.baseKit;
  return {
    name: kitBase?.name ?? null,
    layers: kitBase?.layers ?? [],
    base_source_id: kitBase?.base_source_id ?? null,
    addon_source_ids: kitBase?.addon_source_ids ?? [],
    selections: selectionsToSave,
    include: kitBase?.include ?? [],
    exclude: kitBase?.exclude ?? [],
    replacements: kitBase?.replacements ?? {},
    choice_tree: kitBase?.choice_tree ?? [],
    category_links: kitBase?.category_links ?? [],
  };
}

export function useKitManifestAutosave({
  profileId,
  pendingSelections,
  savedSelections,
  loaded,
  userEdited,
  disabled,
  baseKit,
  onPersisted,
  onSaved,
  onRegisterFlush,
}: Options) {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveStateRef = useRef<ProfileSaveState>({
    profileId,
    inFlight: null,
    queuedSelections: null,
    pendingSelections,
    savedSelections,
    baseKit,
    pendingConfirmation: null,
    retainedFailedKit: retainedFailedKitByProfile.get(profileId) ?? null,
    loaded,
    disabled,
    lastPendingSelectionsProp: pendingSelections,
    lastSavedSelectionsProp: savedSelections,
    lastBaseKitProp: baseKit,
  });
  if (saveStateRef.current.profileId !== profileId) {
    saveStateRef.current = {
      profileId,
      inFlight: null,
      queuedSelections: null,
      pendingSelections,
      savedSelections,
      baseKit,
      pendingConfirmation: null,
      retainedFailedKit: retainedFailedKitByProfile.get(profileId) ?? null,
      loaded,
      disabled,
      lastPendingSelectionsProp: pendingSelections,
      lastSavedSelectionsProp: savedSelections,
      lastBaseKitProp: baseKit,
    };
  }
  const saveState = saveStateRef.current;
  saveState.loaded = loaded;
  saveState.disabled = disabled;
  if (saveState.lastPendingSelectionsProp !== pendingSelections) {
    saveState.lastPendingSelectionsProp = pendingSelections;
    saveState.pendingSelections = pendingSelections;
  }
  if (saveState.lastSavedSelectionsProp !== savedSelections) {
    saveState.lastSavedSelectionsProp = savedSelections;
    saveState.savedSelections = savedSelections;
  }
  if (saveState.lastBaseKitProp !== baseKit) {
    saveState.lastBaseKitProp = baseKit;
    saveState.baseKit = baseKit;
  }

  const dirty = loaded && userEdited && !selectionsEqual(pendingSelections, savedSelections);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  const persistKit = useCallback(
    async (kit: KitManifest, needsManifestPut: boolean, onManifestSaved: () => void) => {
      if (needsManifestPut) {
        const saved = await savePlanKitManifest(profileId, kit);
        onManifestSaved();
        saveState.baseKit = saved;
        saveState.savedSelections = { ...saved.selections };
        saveState.pendingConfirmation = saved;
        saveState.retainedFailedKit = null;
        retainedFailedKitByProfile.delete(profileId);
        clearFailedAuxiliarySave(profileId, "manifest");
      }
      if (saveState.pendingConfirmation) await onPersisted?.(saveState.pendingConfirmation);
      if (saveStateRef.current === saveState) {
        const latestSaved = selectionsEqual(saveState.pendingSelections, saveState.savedSelections);
        if (saveState.pendingConfirmation && latestSaved) await onSaved(saveState.pendingConfirmation);
        saveState.pendingConfirmation = null;
        if (latestSaved) {
          setStatus("saved");
          savedClearTimerRef.current = setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
            savedClearTimerRef.current = null;
          }, KIT_MANIFEST_SAVED_CLEAR_MS);
        } else if (needsManifestPut) {
          setStatus("idle");
        }
      } else {
        saveState.pendingConfirmation = null;
      }
    },
    [onPersisted, onSaved, profileId, saveState],
  );

  const drainQueuedSelections = useCallback(async () => {
    while (saveState.queuedSelections || saveState.pendingConfirmation || saveState.retainedFailedKit) {
      const selectionsToSave = saveState.queuedSelections ?? saveState.savedSelections;
      saveState.queuedSelections = null;
      const needsManifestPut =
        saveState.retainedFailedKit != null ||
        !selectionsEqual(selectionsToSave, saveState.savedSelections);
      if (!needsManifestPut && !saveState.pendingConfirmation) {
        saveState.retainedFailedKit = null;
        continue;
      }

      const isCurrentProfile = saveStateRef.current === saveState;
      if (isCurrentProfile) {
        clearSavedTimer();
        setStatus("saving");
      }
      const kit = saveState.retainedFailedKit ?? kitFromState(saveState, selectionsToSave);
      let manifestPutFailed = needsManifestPut;
      try {
        await persistKit(kit, needsManifestPut, () => {
          manifestPutFailed = false;
        });
      } catch (error) {
        saveState.queuedSelections = null;
        if (manifestPutFailed) {
          saveState.retainedFailedKit = kit;
          // A detached editor must not replace what a newer editor for this Build now owns.
          const mounted = mountedFlushByProfile.get(profileId);
          if (!mounted || mounted.owner === saveState) {
            retainedFailedKitByProfile.set(profileId, kit);
            retainFailedAuxiliarySave(profileId, "manifest", () => retryMountedManifestSave(profileId));
          }
        }
        if (saveStateRef.current === saveState) setStatus("error");
        throw error;
      }
    }
  }, [clearSavedTimer, persistKit, profileId, saveState]);

  const saveSelections = useCallback(
    async (selectionsOverride?: ManifestSelections) => {
      if (!saveState.loaded || saveState.disabled) return;
      const selectionsToSave = selectionsOverride ?? saveState.pendingSelections;
      if (
        !saveState.inFlight &&
        selectionsEqual(selectionsToSave, saveState.savedSelections) &&
        !saveState.pendingConfirmation &&
        !saveState.retainedFailedKit
      ) {
        return;
      }

      saveState.queuedSelections = selectionsToSave;
      const activeRun = saveState.inFlight;
      if (activeRun) {
        await activeRun;
        return;
      }

      const run = drainQueuedSelections();
      saveState.inFlight = run;
      try {
        await run;
      } finally {
        if (saveState.inFlight === run) saveState.inFlight = null;
      }
    },
    [drainQueuedSelections, saveState],
  );

  const flushSave = useCallback(async (mode: BuildSaveFlushMode) => {
    if (saveState.inFlight) {
      await saveState.inFlight;
    }
    // Only a deliberate Retry resends a refused kit; navigation keeps it for that Retry.
    if (saveState.retainedFailedKit && mode !== "retry") {
      throw new Error("Kit selections were not saved. Retry to send them again.");
    }
    if (
      saveState.pendingConfirmation ||
      saveState.retainedFailedKit ||
      !selectionsEqual(saveState.pendingSelections, saveState.savedSelections)
    ) {
      if (!saveState.loaded || saveState.disabled) throw new Error("Kit selections cannot be saved yet");
      await saveSelections(saveState.pendingSelections);
    }
  }, [saveSelections, saveState]);

  const registeredFlushRef = useRef({ profileId, flush: flushSave });
  if (registeredFlushRef.current.profileId !== profileId) {
    registeredFlushRef.current = { profileId, flush: flushSave };
  } else {
    registeredFlushRef.current.flush = flushSave;
  }
  const registeredFlush = registeredFlushRef.current;

  const saveUserEdit = useCallback(
    (selections: ManifestSelections) => {
      saveState.pendingSelections = selections;
      saveState.retainedFailedKit = null;
      retainedFailedKitByProfile.delete(profileId);
      clearFailedAuxiliarySave(profileId, "manifest");
      clearSavedTimer();
      setStatus("pending");
      void saveSelections(selections).catch(() => {});
    },
    [clearSavedTimer, profileId, saveSelections, saveState],
  );

  useEffect(() => {
    const mounted = {
      owner: saveState,
      flush: (mode: BuildSaveFlushMode) => registeredFlush.flush(mode),
    };
    mountedFlushByProfile.set(profileId, mounted);
    return () => {
      if (mountedFlushByProfile.get(profileId) === mounted) mountedFlushByProfile.delete(profileId);
    };
  }, [profileId, registeredFlush, saveState]);

  useEffect(() => {
    if (!onRegisterFlush) return;
    return onRegisterFlush(profileId, (mode) => registeredFlush.flush(mode));
  }, [onRegisterFlush, profileId, registeredFlush]);

  useEffect(() => {
    const flushForProfile = () => registeredFlush.flush("flush");
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        void flushForProfile().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHidden);
      void flushForProfile().catch(() => {});
    };
  }, [registeredFlush]);

  useEffect(() => {
    return () => clearSavedTimer();
  }, [clearSavedTimer]);

  useEffect(() => {
    setStatus(saveStateRef.current.retainedFailedKit ? "error" : "idle");
    clearSavedTimer();
  }, [profileId, clearSavedTimer]);

  useEffect(() => {
    const warnIfUnsaved = (event: BeforeUnloadEvent) => {
      if (saveStateRef.current !== saveState) return;
      if (
        !saveState.inFlight &&
        !saveState.pendingConfirmation &&
        !saveState.retainedFailedKit &&
        status !== "error" &&
        selectionsEqual(saveState.pendingSelections, saveState.savedSelections)
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnIfUnsaved);
    return () => window.removeEventListener("beforeunload", warnIfUnsaved);
  }, [saveState, status]);

  const retrySave = useCallback(() => flushSave("retry"), [flushSave]);

  return { dirty, status, saveNow: retrySave, saveUserEdit };
}
