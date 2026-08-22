import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlanKitManifest, savePlanKitManifest, type KitManifest } from "../api/engine";
import {
  KIT_MANIFEST_SAVED_CLEAR_MS,
  selectionsEqual,
  type KitManifestSaveStatus,
} from "../lib/kitManifestSave";

type Options = {
  profileId: number;
  pendingSelections: Record<string, string>;
  savedSelections: Record<string, string>;
  loaded: boolean;
  userEdited: boolean;
  disabled: boolean;
  baseKit: KitManifest | null;
  onSaved: (kit: KitManifest) => void;
  onRegisterFlush?: (profileId: number, flush: () => Promise<void>) => void;
  onUnregisterFlush?: (profileId: number) => void;
};

export function useKitManifestAutosave({
  profileId,
  pendingSelections,
  savedSelections,
  loaded,
  userEdited,
  disabled,
  baseKit,
  onSaved,
  onRegisterFlush,
  onUnregisterFlush,
}: Options) {
  const [status, setStatus] = useState<KitManifestSaveStatus>("idle");
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingRef = useRef(pendingSelections);
  const savedRef = useRef(savedSelections);
  const loadedRef = useRef(loaded);
  const disabledRef = useRef(disabled);
  const baseKitRef = useRef(baseKit);

  pendingRef.current = pendingSelections;
  savedRef.current = savedSelections;
  loadedRef.current = loaded;
  disabledRef.current = disabled;
  baseKitRef.current = baseKit;

  const dirty = loaded && userEdited && !selectionsEqual(pendingSelections, savedSelections);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  const saveSelections = useCallback(
    async (selectionsOverride?: Record<string, string>) => {
      if (!loadedRef.current || disabledRef.current) return;
      const selectionsToSave = selectionsOverride ?? pendingRef.current;
      if (selectionsEqual(selectionsToSave, savedRef.current)) return;

      if (saveInFlightRef.current) {
        await saveInFlightRef.current;
        if (selectionsEqual(selectionsToSave, savedRef.current)) return;
      }

      clearSavedTimer();
      setStatus("saving");

      const run = (async () => {
        try {
          const kitBase = baseKitRef.current;
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
          const saved = await savePlanKitManifest(profileId, kit);
          savedRef.current = { ...saved.selections };
          onSaved(saved);
          setStatus("saved");
          savedClearTimerRef.current = setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
            savedClearTimerRef.current = null;
          }, KIT_MANIFEST_SAVED_CLEAR_MS);
        } catch {
          setStatus("error");
        } finally {
          saveInFlightRef.current = null;
        }
      })();

      saveInFlightRef.current = run;
      await run;
    },
    [clearSavedTimer, onSaved, profileId],
  );

  const flushSave = useCallback(async () => {
    if (saveInFlightRef.current) {
      await saveInFlightRef.current;
    }
    if (!selectionsEqual(pendingRef.current, savedRef.current)) {
      await saveSelections(pendingRef.current);
    }
  }, [saveSelections]);

  const saveUserEdit = useCallback(
    (selections: Record<string, string>) => {
      pendingRef.current = selections;
      clearSavedTimer();
      setStatus("pending");
      void saveSelections(selections);
    },
    [clearSavedTimer, saveSelections],
  );

  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  useEffect(() => {
    if (!onRegisterFlush) return;
    onRegisterFlush(profileId, flushSave);
    return () => onUnregisterFlush?.(profileId);
  }, [flushSave, onRegisterFlush, onUnregisterFlush, profileId]);

  useEffect(() => {
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        void flushSaveRef.current();
      }
    };
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHidden);
      void flushSaveRef.current();
    };
  }, [profileId]);

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
