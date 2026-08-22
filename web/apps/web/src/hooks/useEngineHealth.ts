import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HealthResponse } from "../api/engine";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";

export function useEngineHealth(_pollMs = 8000) {
  const qc = useQueryClient();
  const { data: health, error, isLoading, isFetching } = useHealthQuery();

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.health });
  }, [qc]);

  return {
    health: health ?? null,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    loading: isLoading,
    fetching: isFetching,
    refresh,
  };
}

export type { HealthResponse };
