import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type FlushFn = () => Promise<void>;

type BuildSaveKind = "importRules" | "kitManifest";

type BuildSaveFlushContextValue = {
  registerFlush: (key: string, flush: FlushFn) => void;
  unregisterFlush: (key: string) => void;
  flushAll: () => Promise<void>;
};

const BuildSaveFlushContext = createContext<BuildSaveFlushContextValue | null>(null);

export function BuildSaveFlushProvider({ children }: { children: ReactNode }) {
  const flushByKey = useRef(new Map<string, FlushFn>());

  const registerFlush = useCallback((key: string, flush: FlushFn) => {
    flushByKey.current.set(key, flush);
  }, []);

  const unregisterFlush = useCallback((key: string) => {
    flushByKey.current.delete(key);
  }, []);

  const flushAll = useCallback(async () => {
    const flushes = [...flushByKey.current.values()];
    await Promise.all(flushes.map((fn) => fn()));
  }, []);

  const value = useMemo(
    () => ({ registerFlush, unregisterFlush, flushAll }),
    [registerFlush, unregisterFlush, flushAll],
  );

  return (
    <BuildSaveFlushContext.Provider value={value}>{children}</BuildSaveFlushContext.Provider>
  );
}

function useBuildSaveFlushContext(): BuildSaveFlushContextValue {
  const ctx = useContext(BuildSaveFlushContext);
  if (!ctx) {
    throw new Error("Build save flush hooks must be used within BuildSaveFlushProvider");
  }
  return ctx;
}

/** Registers autosave flushes by Source id (import rules) or Profile id (kit manifest). */
export function useBuildSaveFlushRegistry(kind: BuildSaveKind) {
  const { registerFlush, unregisterFlush } = useBuildSaveFlushContext();
  return useMemo(
    () => ({
      registerFlush: (id: number, flush: FlushFn) => registerFlush(`${kind}:${id}`, flush),
      unregisterFlush: (id: number) => unregisterFlush(`${kind}:${id}`),
    }),
    [kind, registerFlush, unregisterFlush],
  );
}

/** Await pending import-rule and kit-manifest writes before leaving Build. */
export function useFlushBuildPageSaves(): () => Promise<void> {
  return useBuildSaveFlushContext().flushAll;
}
