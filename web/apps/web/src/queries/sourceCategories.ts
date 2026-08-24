import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSourceCategories,
  saveSourceCategories,
} from "../api/engine";
import { queryKeys } from "./keys";

export function useSourceCategoriesQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sourceCategories,
    queryFn: fetchSourceCategories,
    enabled,
  });
}

export function useSaveSourceCategoriesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveSourceCategories,
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourceCategories, saved);
    },
  });
}
