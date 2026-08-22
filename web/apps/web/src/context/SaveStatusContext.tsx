import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

type SaveStatusEntry = {
  label: string;
  status: SaveStatus;
  error?: string | null;
};

type SaveStatusContextValue = {
  entries: SaveStatusEntry[];
  reportStatus: (key: string, label: string, status: SaveStatus, error?: string | null) => void;
  clearStatus: (key: string) => void;
};

const SaveStatusContext = createContext<SaveStatusContextValue | null>(null);

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [byKey, setByKey] = useState<Map<string, SaveStatusEntry>>(new Map());

  const reportStatus = useCallback(
    (key: string, label: string, status: SaveStatus, error?: string | null) => {
      setByKey((prev) => {
        const next = new Map(prev);
        if (status === "idle") {
          next.delete(key);
        } else {
          next.set(key, { label, status, error });
        }
        return next;
      });
    },
    [],
  );

  const clearStatus = useCallback((key: string) => {
    setByKey((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const entries = useMemo(
    () => [...byKey.values()].filter((e) => e.status !== "idle"),
    [byKey],
  );

  const value = useMemo(
    () => ({ entries, reportStatus, clearStatus }),
    [entries, reportStatus, clearStatus],
  );

  return (
    <SaveStatusContext.Provider value={value}>{children}</SaveStatusContext.Provider>
  );
}

export function useSaveStatusRegistry() {
  const ctx = useContext(SaveStatusContext);
  if (!ctx) {
    throw new Error("useSaveStatusRegistry must be used within SaveStatusProvider");
  }
  return ctx;
}

export function useSaveStatusReporter(key: string, label: string) {
  const { reportStatus } = useSaveStatusRegistry();
  return useCallback(
    (status: SaveStatus, error?: string | null) => {
      reportStatus(key, label, status, error);
    },
    [key, label, reportStatus],
  );
}
