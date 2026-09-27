import { useQuery } from "@tanstack/react-query";
import { fetchSlicerProfileOptions } from "../api/endpoints/slicers";
import { queryKeys } from "./keys";

export function useSlicerProfileOptionsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.slicerProfileOptions,
    queryFn: fetchSlicerProfileOptions,
    enabled,
  });
}
