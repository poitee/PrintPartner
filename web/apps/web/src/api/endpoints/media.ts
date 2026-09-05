import { THUMBNAIL_RENDERER_VERSION } from "@print-partner/contracts";
import { resolveEngineUrl } from "../contractRequest";
import { engineFetch, engineSendMultipart } from "../engineTransport";

const ACCEPTED_MEDIA_BASIS_PATTERN = /^[0-9a-f]{64}$/;
const ACCEPTED_RENDER_HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export type AcceptedPartMediaMetadata = {
  readonly basis: string;
  readonly renderHex: string | null;
};

export async function partThumbnailUrl(partId: number): Promise<string> {
  return resolveEngineUrl(`/parts/${partId}/thumbnail`);
}

export async function regeneratePlanThumbnails(
  profileId: number,
): Promise<{ cleared: number }> {
  return engineFetch(`/plans/${profileId}/regenerate-thumbnails`, {
    method: "POST",
  });
}

export function acceptedPartMediaMetadata(response: Response): AcceptedPartMediaMetadata {
  const etag = response.headers.get("ETag") ?? "";
  const match = /^"([0-9a-f]{64})"$/.exec(etag);
  if (!match) throw new Error("Response is missing a strong accepted media ETag");
  const basis = match[1];
  if (!basis) throw new Error("Response is missing an accepted media basis");
  const rawHex = response.headers.get("X-Accepted-Render-Hex")?.trim() ?? "";
  return {
    basis,
    renderHex: ACCEPTED_RENDER_HEX_PATTERN.test(rawHex) ? rawHex.toLowerCase() : null,
  };
}

export function acceptedPartMediaRevalidationHeaders(basis: string | null): HeadersInit {
  if (basis == null) return {};
  if (!ACCEPTED_MEDIA_BASIS_PATTERN.test(basis)) {
    throw new Error("Invalid accepted media basis");
  }
  return { "If-None-Match": `"${basis}"` };
}

export async function uploadPartThumbnail(
  partId: number,
  pngBlob: Blob,
  meshBasis: string,
): Promise<void> {
  if (!ACCEPTED_MEDIA_BASIS_PATTERN.test(meshBasis)) {
    throw new Error("Invalid accepted media basis");
  }
  const form = new FormData();
  form.append("file", pngBlob, "thumbnail.png");
  await engineSendMultipart({
    path: `/parts/${partId}/thumbnail`,
    headers: {
      "If-Match": `"${meshBasis}"`,
      "X-Thumbnail-Renderer-Version": THUMBNAIL_RENDERER_VERSION,
    },
    form,
    failureMessage: "Thumbnail upload failed",
  });
}

/** Cached cover image for a source (GitHub social preview, Printables og:image, README, etc.). */
export async function sourceCoverUrl(sourceId: number): Promise<string> {
  return resolveEngineUrl(`/sources/${sourceId}/cover`);
}

export async function partPreviewUrl(partId: number): Promise<string> {
  return resolveEngineUrl(`/parts/${partId}/preview`);
}

export async function partMeshUrl(partId: number): Promise<string> {
  return resolveEngineUrl(`/parts/${partId}/mesh`);
}

function encodeStlRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function sourceStlMeshUrl(sourceId: number, relativePath: string): Promise<string> {
  return resolveEngineUrl(`/sources/${sourceId}/stl/${encodeStlRelativePath(relativePath)}/mesh`);
}

export async function sourceStlPreviewUrl(sourceId: number, relativePath: string): Promise<string> {
  return resolveEngineUrl(`/sources/${sourceId}/stl/${encodeStlRelativePath(relativePath)}/preview`);
}
