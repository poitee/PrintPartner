export type PreviewTarget =
  | { kind: "part"; partId: number }
  | { kind: "source"; sourceId: number; relativePath: string };

/** Perceived luminance (0..1) of a hex color like "#1a2b3c". */
export function perceivedLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0.5;
  const value = parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
}

/**
 * Backdrops the viewer can put behind a mesh. Supplied by the theme
 * (lib/previewTheme.ts) so this module stays a pure model.
 */
export type PreviewBackdrops = Readonly<{
  /** --media-bg: the backdrop every preview uses by default. */
  background: string;
  /** Mid-tone stand-in for meshes that would vanish into `background`. */
  backgroundContrast: string;
}>;

/** Luminance gap below which a mesh loses its silhouette against a backdrop. */
const MIN_SEPARATION = 0.18;

/**
 * Keep the media backdrop unless the mesh colour sits too close to it — a
 * near-black part on a near-black stage, or a white part on light paper.
 */
export function contrastBackground(meshHex: string, backdrops: PreviewBackdrops): string {
  const separation = Math.abs(
    perceivedLuminance(meshHex) - perceivedLuminance(backdrops.background),
  );
  return separation < MIN_SEPARATION ? backdrops.backgroundContrast : backdrops.background;
}

/** STL units are millimeters by convention. */
export function formatMm(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function previewTarget(
  partId: number | null,
  sourceId: number | null | undefined,
  relativePath: string | null | undefined,
  preferSource = false,
): PreviewTarget | null {
  if (preferSource && sourceId != null && relativePath) {
    return { kind: "source", sourceId, relativePath };
  }
  if (partId != null) return { kind: "part", partId };
  if (sourceId != null && relativePath) {
    return { kind: "source", sourceId, relativePath };
  }
  return null;
}

export function previewErrorMessage(status: number, kind: "mesh" | "png"): string {
  if (status === 404 && kind === "mesh") {
    return "STL not ready yet — source may still be syncing. Wait a moment and try again.";
  }
  if (status === 413) {
    return "STL is too large for live 3D preview — showing PNG instead.";
  }
  if (status === 404) {
    return "Preview image not available for this part.";
  }
  return `Preview unavailable (HTTP ${status}).`;
}

export function previewUrlWithColor(url: string, meshColor: string): string {
  const hex = meshColor.trim();
  if (!hex) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}hex=${encodeURIComponent(hex)}`;
}

export function normalizedRenderHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}
