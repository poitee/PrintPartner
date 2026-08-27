import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DATE_FORMAT_DEFAULT,
  formatTimestamp,
  type DateFormatId,
} from "@print-partner/contracts";
import {
  fetchDateFormatSetting,
  saveDateFormatSetting,
} from "../api/endpoints/settings";
import { useAuth } from "./AuthContext";

type DateFormatContextValue = {
  format: DateFormatId;
  setFormat: (next: DateFormatId) => void;
  formatDate: (iso: string | null | undefined) => string;
};

const DateFormatContext = createContext<DateFormatContextValue | null>(null);

export function DateFormatProvider({ children }: { children: ReactNode }) {
  const { user, multiUser, loading: authLoading } = useAuth();
  const [format, setFormatState] = useState<DateFormatId>(DATE_FORMAT_DEFAULT);
  const canLoadSetting = !authLoading && (!multiUser || user !== null);

  useEffect(() => {
    if (!canLoadSetting) return;

    let cancelled = false;
    void fetchDateFormatSetting()
      .then((res) => {
        if (!cancelled) setFormatState(res.format);
      })
      .catch(() => {
        /* keep default on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [canLoadSetting]);

  const setFormat = useCallback((next: DateFormatId) => {
    setFormatState(next);
    void saveDateFormatSetting(next).catch(() => {
      /* best-effort persist */
    });
  }, []);

  const formatDate = useCallback(
    (iso: string | null | undefined) => formatTimestamp(iso, format),
    [format],
  );

  const value = useMemo(
    () => ({ format, setFormat, formatDate }),
    [format, setFormat, formatDate],
  );

  return <DateFormatContext.Provider value={value}>{children}</DateFormatContext.Provider>;
}

export function useDateFormat() {
  const ctx = useContext(DateFormatContext);
  if (!ctx) throw new Error("useDateFormat must be used within DateFormatProvider");
  return ctx;
}
