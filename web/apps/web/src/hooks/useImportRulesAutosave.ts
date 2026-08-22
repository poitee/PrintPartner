import { useCallback, useEffect, useRef, useState } from "react";
import { saveImportRules } from "../api/engine";
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
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingRulesRef = useRef(pendingRules);
  const savedRulesRef = useRef(savedRules);
  const userEditedRef = useRef(userEdited);
  const rulesLoadedRef = useRef(rulesLoaded);
  const disabledRef = useRef(disabled);

  pendingRulesRef.current = pendingRules;
  savedRulesRef.current = savedRules;
  userEditedRef.current = userEdited;
  rulesLoadedRef.current = rulesLoaded;
  disabledRef.current = disabled;

  const dirty =
    rulesLoaded && userEdited && !rulesEqual(pendingRules, savedRules);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  const saveRules = useCallback(
    async (rulesOverride?: string[]) => {
      if (disabledRef.current) return;
      const rulesToSave = rulesOverride ?? pendingRulesRef.current;
      if (rulesEqual(rulesToSave, savedRulesRef.current)) return;

      if (saveInFlightRef.current) {
        await saveInFlightRef.current;
        if (rulesEqual(rulesToSave, savedRulesRef.current)) return;
      }

      clearSavedTimer();
      setStatus("saving");

      const run = (async () => {
        try {
          const result = await saveImportRules(sourceId, rulesToSave);
          savedRulesRef.current = result.rules;
          onSaved(result.rules);
          setStatus("saved");
          savedClearTimerRef.current = setTimeout(() => {
            setStatus((current) => (current === "saved" ? "idle" : current));
            savedClearTimerRef.current = null;
          }, IMPORT_RULES_SAVED_CLEAR_MS);
        } catch {
          setStatus("error");
        } finally {
          saveInFlightRef.current = null;
        }
      })();

      saveInFlightRef.current = run;
      await run;
    },
    [clearSavedTimer, onSaved, sourceId],
  );

  const flushSave = useCallback(async () => {
    if (saveInFlightRef.current) {
      await saveInFlightRef.current;
    }
    if (!rulesEqual(pendingRulesRef.current, savedRulesRef.current)) {
      await saveRules(pendingRulesRef.current);
    }
  }, [saveRules]);

  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  /** PUT immediately on toggle — rules arg avoids stale React state if user navigates away. */
  const saveUserEdit = useCallback(
    (rules: string[]) => {
      pendingRulesRef.current = rules;
      userEditedRef.current = true;
      clearSavedTimer();
      setStatus("pending");
      void saveRules(rules);
    },
    [clearSavedTimer, saveRules],
  );

  useEffect(() => {
    if (!onRegisterFlush) return;
    onRegisterFlush(sourceId, flushSave);
    return () => onUnregisterFlush?.(sourceId);
  }, [flushSave, onRegisterFlush, onUnregisterFlush, sourceId]);

  useEffect(() => {
    return () => {
      void flushSaveRef.current();
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
