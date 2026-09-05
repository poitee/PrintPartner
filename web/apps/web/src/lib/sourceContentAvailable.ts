import type { SourceSummary } from "@print-partner/contracts";

type SourceContentAvailability = Pick<SourceSummary, "content_available" | "local_path">;

export function sourceContentAvailable(
  source: SourceContentAvailability | null | undefined,
): boolean {
  return source?.content_available ?? Boolean(source?.local_path);
}
