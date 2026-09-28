import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  DATE_FORMAT_DEFAULT,
  formatTimestamp,
  type DateFormatId,
} from "@print-partner/contracts";
import { saveDateFormatSetting } from "../api/endpoints/settings";
import { publishDateFormatSetting, useDateFormatSettingQuery } from "../queries/dateFormat";
import { useAuth } from "./AuthContext";

type DateFormatContextValue = {
  format: DateFormatId;
  setFormat: (next: DateFormatId) => void;
  formatDate: (iso: string | null | undefined) => string;
};

const DateFormatContext = createContext<DateFormatContextValue | null>(null);

export function DateFormatProvider({ children }: { children: ReactNode }) {
  const { user, multiUser, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const canLoadSetting = !authLoading && (!multiUser || user !== null);
  const format = useDateFormatSettingQuery(canLoadSetting).data?.format ?? DATE_FORMAT_DEFAULT;

  const setFormat = useCallback((next: DateFormatId) => {
    publishDateFormatSetting(queryClient, next);
    void saveDateFormatSetting(next).catch(() => {
      /* best-effort persist */
    });
  }, [queryClient]);

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
