import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type FlushFn = () => Promise<void>;

type ImportRulesSaveContextValue = {
  registerFlush: (sourceId: number, flush: FlushFn) => void;
  unregisterFlush: (sourceId: number) => void;
  flushAll: () => Promise<void>;
};

const ImportRulesSaveContext = createContext<ImportRulesSaveContextValue | null>(null);

export function ImportRulesSaveProvider({ children }: { children: ReactNode }) {
  const flushBySource = useRef(new Map<number, FlushFn>());

  const registerFlush = useCallback((sourceId: number, flush: FlushFn) => {
    flushBySource.current.set(sourceId, flush);
  }, []);

  const unregisterFlush = useCallback((sourceId: number) => {
    flushBySource.current.delete(sourceId);
  }, []);

  const flushAll = useCallback(async () => {
    const flushes = [...flushBySource.current.values()];
    await Promise.all(flushes.map((fn) => fn()));
  }, []);

  const value = useMemo(
    () => ({ registerFlush, unregisterFlush, flushAll }),
    [registerFlush, unregisterFlush, flushAll],
  );

  return (
    <ImportRulesSaveContext.Provider value={value}>{children}</ImportRulesSaveContext.Provider>
  );
}

export function useImportRulesSaveRegistry(): ImportRulesSaveContextValue {
  const ctx = useContext(ImportRulesSaveContext);
  if (!ctx) {
    throw new Error("useImportRulesSaveRegistry must be used within ImportRulesSaveProvider");
  }
  return ctx;
}
