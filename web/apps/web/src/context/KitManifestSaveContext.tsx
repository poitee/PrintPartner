import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type FlushFn = () => Promise<void>;

type KitManifestSaveContextValue = {
  registerFlush: (profileId: number, flush: FlushFn) => void;
  unregisterFlush: (profileId: number) => void;
  flushAll: () => Promise<void>;
};

const KitManifestSaveContext = createContext<KitManifestSaveContextValue | null>(null);

export function KitManifestSaveProvider({ children }: { children: ReactNode }) {
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
    <KitManifestSaveContext.Provider value={value}>{children}</KitManifestSaveContext.Provider>
  );
}

export function useKitManifestSaveRegistry(): KitManifestSaveContextValue {
  const ctx = useContext(KitManifestSaveContext);
  if (!ctx) {
    throw new Error("useKitManifestSaveRegistry must be used within KitManifestSaveProvider");
  }
  return ctx;
}
