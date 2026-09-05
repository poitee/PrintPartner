import { useCallback, useEffect, useRef, useState } from "react";
import type { ManifestSelections } from "@print-partner/contracts";
import {
  fetchPlanKitManifest,
  savePlanKitManifest,
  type KitManifest,
} from "../api/endpoints/planManifests";
import {
  KIT_MANIFEST_SAVED_CLEAR_MS,
  selectionsEqual,
  type KitManifestSaveStatus,
} from "../lib/kitManifestSave";

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
  onRegisterFlush?: (profileId: number, flush: () => Promise<void>) => void;
  onUnregisterFlush?: (profileId: number) => void;
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
};

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
  onUnregisterFlush,
}: Options) {
  const [status, setStatus] = useState<KitManifestSaveStatus>("idle");
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveStateRef = useRef<ProfileSaveState>({
    profileId,
    inFlight: null,
    queuedSelections: null,
    pendingSelections,
    savedSelections,
    baseKit,
    pendingConfirmation: null,
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

  const drainQueuedSelections = useCallback(async () => {
    while (saveState.queuedSelections || saveState.pendingConfirmation) {
      const selectionsToSave = saveState.queuedSelections ?? saveState.savedSelections;
      saveState.queuedSelections = null;
      const needsSave = !selectionsEqual(selectionsToSave, saveState.savedSelections);
      if (!needsSave && !saveState.pendingConfirmation) continue;

      const isCurrentProfile = saveStateRef.current === saveState;
      if (isCurrentProfile) {
        clearSavedTimer();
        setStatus("saving");
      }
      try {
        const kitBase = saveState.baseKit;
        const kit: KitManifest = {
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
        if (needsSave) {
          const saved = await savePlanKitManifest(profileId, kit);
          saveState.baseKit = saved;
          saveState.savedSelections = { ...saved.selections };
          saveState.pendingConfirmation = saved;
        }
        if (saveState.pendingConfirmation) await onPersisted?.(saveState.pendingConfirmation);
        if (saveStateRef.current === saveState) {
          if (saveState.pendingConfirmation) await onSaved(saveState.pendingConfirmation);
          saveState.pendingConfirmation = null;
          setStatus("saved");
          savedClearTimerRef.current = setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
            savedClearTimerRef.current = null;
          }, KIT_MANIFEST_SAVED_CLEAR_MS);
        } else {
          saveState.pendingConfirmation = null;
        }
      } catch {
        saveState.queuedSelections = null;
        if (saveStateRef.current === saveState) setStatus("error");
        return;
      }
    }
  }, [clearSavedTimer, onPersisted, onSaved, profileId, saveState]);

  const saveSelections = useCallback(
    async (selectionsOverride?: ManifestSelections) => {
      if (!saveState.loaded || saveState.disabled) return;
      const selectionsToSave = selectionsOverride ?? saveState.pendingSelections;
      if (
        !saveState.inFlight &&
        selectionsEqual(selectionsToSave, saveState.savedSelections) &&
        !saveState.pendingConfirmation
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

  const flushSave = useCallback(async () => {
    if (saveState.inFlight) {
      await saveState.inFlight;
    }
    if (saveState.pendingConfirmation || !selectionsEqual(saveState.pendingSelections, saveState.savedSelections)) {
      await saveSelections(saveState.pendingSelections);
    }
  }, [saveSelections, saveState]);

  const saveUserEdit = useCallback(
    (selections: ManifestSelections) => {
      saveState.pendingSelections = selections;
      clearSavedTimer();
      setStatus("pending");
      void saveSelections(selections);
    },
    [clearSavedTimer, saveSelections, saveState],
  );

  useEffect(() => {
    if (!onRegisterFlush) return;
    onRegisterFlush(profileId, flushSave);
    return () => onUnregisterFlush?.(profileId);
  }, [flushSave, onRegisterFlush, onUnregisterFlush, profileId]);

  useEffect(() => {
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        void flushSave();
      }
    };
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHidden);
      void flushSave();
    };
  }, [flushSave]);

  useEffect(() => {
    return () => clearSavedTimer();
  }, [clearSavedTimer]);

  useEffect(() => {
    setStatus("idle");
    clearSavedTimer();
  }, [profileId, clearSavedTimer]);

  return { dirty, status, saveNow: flushSave, saveUserEdit };
}

export async function loadKitManifestState(profileId: number): Promise<KitManifest> {
  return fetchPlanKitManifest(profileId);
}
