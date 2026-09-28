import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type FlushFn = () => Promise<void>;

type BuildSaveFlushContextValue = {
  registerFlush: (profileId: number, flush: FlushFn) => void;
  unregisterFlush: (profileId: number) => void;
  flushAll: () => Promise<void>;
};

const BuildSaveFlushContext = createContext<BuildSaveFlushContextValue | null>(null);

export function BuildSaveFlushProvider({ children }: { children: ReactNode }) {
  const flushByProfile = useRef(new Map<number, FlushFn>());

  const registerFlush = useCallback((profileId: number, flush: FlushFn) => {
    flushByProfile.current.set(profileId, flush);
  }, []);

  const unregisterFlush = useCallback((profileId: number) => {
    flushByProfile.current.delete(profileId);
  }, []);

  const flushAll = useCallback(async () => {
    const flushes = [...flushByProfile.current.values()];
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

/** Registers kit-manifest autosave flushes by Profile id. */
export function useBuildSaveFlushRegistry() {
  const { registerFlush, unregisterFlush } = useBuildSaveFlushContext();
  return useMemo(() => ({ registerFlush, unregisterFlush }), [registerFlush, unregisterFlush]);
}

/** Await pending kit-manifest writes before leaving Build. */
export function useFlushBuildPageSaves(): () => Promise<void> {
  return useBuildSaveFlushContext().flushAll;
}
