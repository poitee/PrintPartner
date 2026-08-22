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
  fetchDateFormatSetting,
  formatTimestamp,
  saveDateFormatSetting,
  type DateFormatId,
} from "../api/engine";

type DateFormatContextValue = {
  format: DateFormatId;
  setFormat: (next: DateFormatId) => void;
  formatDate: (iso: string | null | undefined) => string;
};

const DateFormatContext = createContext<DateFormatContextValue | null>(null);

export function DateFormatProvider({ children }: { children: ReactNode }) {
  const [format, setFormatState] = useState<DateFormatId>(DATE_FORMAT_DEFAULT);

  useEffect(() => {
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
  }, []);

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
