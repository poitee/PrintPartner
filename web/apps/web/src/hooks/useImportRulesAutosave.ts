import { useCallback, useEffect, useRef, useState } from "react";
import { saveImportRules } from "../api/endpoints/sources";
import {
  IMPORT_RULES_SAVED_CLEAR_MS,
  rulesEqual,
  type ImportRulesSaveStatus,
} from "../lib/importRulesSave";

type Options = {
  sourceId: number;
  pendingRules: string[];
  savedRules: string[];
  rulesLoaded: boolean;
  userEdited: boolean;
  disabled: boolean;
  onSaved: (rules: string[]) => void;
  onRegisterFlush?: (sourceId: number, flush: () => Promise<void>) => void;
  onUnregisterFlush?: (sourceId: number) => void;
};

type SourceSaveState = {
  sourceId: number;
  inFlight: Promise<void> | null;
  queuedRules: string[] | null;
  pendingRules: string[];
  savedRules: string[];
  lastPendingRulesProp: string[];
  lastSavedRulesProp: string[];
  rulesLoaded: boolean;
  disabled: boolean;
};

export function useImportRulesAutosave({
  sourceId,
  pendingRules,
  savedRules,
  rulesLoaded,
  userEdited,
  disabled,
  onSaved,
  onRegisterFlush,
  onUnregisterFlush,
}: Options) {
  const [status, setStatus] = useState<ImportRulesSaveStatus>("idle");
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStateRef = useRef<SourceSaveState>({
    sourceId,
    inFlight: null,
    queuedRules: null,
    pendingRules,
    savedRules,
    lastPendingRulesProp: pendingRules,
    lastSavedRulesProp: savedRules,
    rulesLoaded,
    disabled,
  });
  if (saveStateRef.current.sourceId !== sourceId) {
    saveStateRef.current = {
      sourceId,
      inFlight: null,
      queuedRules: null,
      pendingRules,
      savedRules,
      lastPendingRulesProp: pendingRules,
      lastSavedRulesProp: savedRules,
      rulesLoaded,
      disabled,
    };
  }
  const saveState = saveStateRef.current;
  saveState.rulesLoaded = rulesLoaded;
  saveState.disabled = disabled;
  if (saveState.lastPendingRulesProp !== pendingRules) {
    saveState.lastPendingRulesProp = pendingRules;
    saveState.pendingRules = pendingRules;
  }
  if (saveState.lastSavedRulesProp !== savedRules) {
    saveState.lastSavedRulesProp = savedRules;
    saveState.savedRules = savedRules;
  }

  const dirty = rulesLoaded && userEdited && !rulesEqual(pendingRules, savedRules);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  const drainQueuedRules = useCallback(async () => {
    while (saveState.queuedRules) {
      const rulesToSave = saveState.queuedRules;
      saveState.queuedRules = null;
      if (rulesEqual(rulesToSave, saveState.savedRules)) continue;
      if (saveStateRef.current === saveState) {
        clearSavedTimer();
        setStatus("saving");
      }
      try {
        const result = await saveImportRules(sourceId, rulesToSave);
        saveState.savedRules = result.rules;
        if (saveStateRef.current === saveState && rulesEqual(saveState.pendingRules, result.rules)) {
          onSaved(result.rules);
          setStatus("saved");
          savedClearTimerRef.current = setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
            savedClearTimerRef.current = null;
          }, IMPORT_RULES_SAVED_CLEAR_MS);
        }
      } catch (error) {
        saveState.queuedRules = null;
        if (saveStateRef.current === saveState) setStatus("error");
        throw error;
      }
    }
  }, [clearSavedTimer, onSaved, saveState, sourceId]);

  const saveRules = useCallback(async (rulesOverride?: string[]) => {
    if (!saveState.rulesLoaded || saveState.disabled) return;
    const rulesToSave = rulesOverride ?? saveState.pendingRules;
    if (!saveState.inFlight && rulesEqual(rulesToSave, saveState.savedRules)) return;
    saveState.queuedRules = rulesToSave;
    if (saveState.inFlight) return saveState.inFlight;

    const run = drainQueuedRules();
    saveState.inFlight = run;
    try {
      await run;
    } finally {
      if (saveState.inFlight === run) saveState.inFlight = null;
    }
  }, [drainQueuedRules, saveState]);

  const flushSave = useCallback(async () => {
    if (saveState.inFlight) await saveState.inFlight;
    if (!rulesEqual(saveState.pendingRules, saveState.savedRules)) {
      if (!saveState.rulesLoaded || saveState.disabled) throw new Error("Source rules cannot be saved yet");
      await saveRules(saveState.pendingRules);
    }
  }, [saveRules, saveState]);

  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  const saveUserEdit = useCallback((rules: string[]) => {
    saveState.pendingRules = rules;
    clearSavedTimer();
    setStatus("pending");
    void saveRules(rules).catch(() => {});
  }, [clearSavedTimer, saveRules, saveState]);

  useEffect(() => {
    if (!onRegisterFlush) return;
    onRegisterFlush(sourceId, flushSave);
    return () => onUnregisterFlush?.(sourceId);
  }, [flushSave, onRegisterFlush, onUnregisterFlush, sourceId]);

  useEffect(() => {
    return () => {
      void flushSaveRef.current().catch(() => {});
    };
  }, [sourceId]);

  useEffect(() => {
    return () => clearSavedTimer();
  }, [clearSavedTimer]);

  useEffect(() => {
    setStatus("idle");
    clearSavedTimer();
  }, [sourceId, clearSavedTimer]);

  return { dirty, status, saveNow: flushSave, saveUserEdit };
}
