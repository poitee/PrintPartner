import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

/**
 * "flush" settles pending edits and refuses with a retained failed save without resending it.
 * "retry" is a deliberate Retry: it also resends the retained failed save.
 */
export type BuildSaveFlushMode = "flush" | "retry";
type FlushFn = (mode: BuildSaveFlushMode) => Promise<void>;
type UnregisterFlush = () => void;

type BuildSaveFlushContextValue = {
  registerFlush: (profileId: number, flush: FlushFn) => UnregisterFlush;
  flushAll: () => Promise<void>;
  retryAll: () => Promise<void>;
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

  const runAll = useCallback(async (mode: BuildSaveFlushMode) => {
    const flushes = [...flushByProfile.current.values()].flatMap((registrations) =>
      [...registrations.values()],
    );
    const results = await Promise.allSettled(flushes.map((flush) => flush(mode)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }, []);
  const flushAll = useCallback(() => runAll("flush"), [runAll]);
  const retryAll = useCallback(() => runAll("retry"), [runAll]);

  const value = useMemo(
    () => ({ registerFlush, flushAll, retryAll }),
    [registerFlush, flushAll, retryAll],
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

/** Registers kit-manifest or special-request autosave flushes by Profile id. */
export function useBuildSaveFlushRegistry() {
  return useBuildSaveFlushContext().registerFlush;
}

/** Await pending kit-manifest writes before leaving Build. Never resends a failed save. */
export function useFlushBuildPageSaves(): () => Promise<void> {
  return useBuildSaveFlushContext().flushAll;
}

/** Deliberate Retry: resend every retained failed save, then settle pending edits. */
export function useRetryBuildPageSaves(): () => Promise<void> {
  return useBuildSaveFlushContext().retryAll;
}
