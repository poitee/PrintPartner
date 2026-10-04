import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type FlushFn = () => Promise<void>;
type UnregisterFlush = () => void;

type BuildSaveFlushContextValue = {
  registerFlush: (profileId: number, flush: FlushFn) => UnregisterFlush;
  flushAll: () => Promise<void>;
};

const BuildSaveFlushContext = createContext<BuildSaveFlushContextValue | null>(null);

export function BuildSaveFlushProvider({ children }: { children: ReactNode }) {
  const flushByProfile = useRef(new Map<number, Map<symbol, FlushFn>>());

  const registerFlush = useCallback((profileId: number, flush: FlushFn) => {
    const token = Symbol();
    const registrations = flushByProfile.current.get(profileId) ?? new Map<symbol, FlushFn>();
    registrations.set(token, flush);
    flushByProfile.current.set(profileId, registrations);
    return () => {
      const current = flushByProfile.current.get(profileId);
      if (!current) return;
      current.delete(token);
      if (current.size === 0) flushByProfile.current.delete(profileId);
    };
  }, []);

  const flushAll = useCallback(async () => {
    const flushes = [...flushByProfile.current.values()].flatMap((registrations) =>
      [...registrations.values()]
    );
    const results = await Promise.allSettled(flushes.map((flush) => flush()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }, []);

  const value = useMemo(
    () => ({ registerFlush, flushAll }),
    [registerFlush, flushAll],
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

export function useBuildSaveFlushRegistry() {
  const { registerFlush } = useBuildSaveFlushContext();
  return registerFlush;
}

export function useFlushBuildPageSaves(): () => Promise<void> {
  return useBuildSaveFlushContext().flushAll;
}
