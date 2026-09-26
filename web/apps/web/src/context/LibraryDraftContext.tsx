import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

type LibraryDraftContextValue = {
  setDirty: (dirty: boolean) => void;
  hasDirtyDraft: () => boolean;
};

const LibraryDraftContext = createContext<LibraryDraftContextValue | null>(null);

export function LibraryDraftProvider({ children }: { children: ReactNode }) {
  const dirtyRef = useRef(false);
  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const hasDirtyDraft = useCallback(() => dirtyRef.current, []);
  const value = useMemo(() => ({ setDirty, hasDirtyDraft }), [setDirty, hasDirtyDraft]);

  return <LibraryDraftContext.Provider value={value}>{children}</LibraryDraftContext.Provider>;
}

export function useLibraryDraft(): LibraryDraftContextValue {
  const value = useContext(LibraryDraftContext);
  if (!value) throw new Error("useLibraryDraft must be used within LibraryDraftProvider");
  return value;
}

export function confirmDiscardSourceChanges(): boolean {
  return window.confirm("Discard unsaved Source changes?");
}
