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
    onMutate: async (categories) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.sourceCategories });
      const previous = queryClient.getQueryData<string[]>(queryKeys.sourceCategories);
      queryClient.setQueryData(queryKeys.sourceCategories, categories);
      return { previous };
    },
    onError: (_error, _categories, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.sourceCategories, context.previous);
      } else {
        queryClient.removeQueries({ queryKey: queryKeys.sourceCategories, exact: true });
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.sourceCategories, saved);
    },
  });
}
