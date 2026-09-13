import { referenceShareSchema, type ReferenceShare } from "@print-partner/contracts";
import { githubOpengraphImageUrl } from "./source-cover.js";

export const BOARD_CAPTION_MAX = 500;
export const BOARD_COMMENT_MAX = 2000;
export const BOARD_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export function normalizeBoardCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const caption = raw.trim();
  if (caption.length < 1 || caption.length > BOARD_CAPTION_MAX) return null;
  return caption;
}

export function normalizeBoardComment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.trim();
  if (body.length < 1 || body.length > BOARD_COMMENT_MAX) return null;
  return body;
}

export function freezeBuildSnapshot(manifest: unknown): { json: string; title: string; parsed: ReferenceShare } | null {
  const parsed = referenceShareSchema.safeParse(manifest);
  if (!parsed.success || parsed.data.kind !== "build") return null;
  const json = JSON.stringify(parsed.data);
  if (Buffer.byteLength(json, "utf8") > BOARD_SNAPSHOT_MAX_BYTES) return null;
  return { json, title: parsed.data.title, parsed: parsed.data };
}

export function coverUrlFromSnapshot(manifest: ReferenceShare): string | null {
  for (const source of manifest.sources) {
    if (source.location.kind !== "publisher") continue;
    const cover = githubOpengraphImageUrl(source.location.url);
    if (cover) return cover;
  }
  return null;
}
