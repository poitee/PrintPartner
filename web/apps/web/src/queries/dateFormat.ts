import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { DateFormatId } from "@print-partner/contracts";
import { fetchDateFormatSetting } from "../api/endpoints/settings";
import { queryKeys } from "./keys";

export function useDateFormatSettingQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dateFormatSetting,
    queryFn: fetchDateFormatSetting,
    enabled,
  });
}

export function publishDateFormatSetting(queryClient: QueryClient, format: DateFormatId) {
  queryClient.setQueryData(queryKeys.dateFormatSetting, { format });
}
