/**
 * previewTheme.ts
 * ---------------
 * One resolved colour source for every renderer that draws the user's own
 * content: the STL viewer, the inline Part thumbnails, and the accepted-Plate
 * previews. Those renderers used to carry a second, private palette (a cool
 * blue studio, a near-black bed, five hard-coded ramp hexes) that never moved
 * when the theme did.
 *
 * Everything here is read from the CSS custom properties on <html> at call
 * time, never copied, so the renderers inherit whatever the stylesheet says.
 * ThemeProvider toggles a `dark` class on <html>; a MutationObserver on that
 * attribute re-resolves and notifies subscribers, so live previews follow a
 * theme switch without a remount.
 *
 * Two rules the shape encodes:
 *
 *  1. Rig colour is hue-only. The rig borrows the palette's warm pole
 *     (--warning) for the key, its cool pole (--info) for the fill and the
 *     room colour (--media-bg) for the ambient, then forces lightness to a
 *     fixed photometric value and caps saturation in the single digits. Light
 *     and dark therefore light a mesh identically: the chrome may change
 *     between themes, but how bright and how tinted a filament colour renders
 *     may not — that fidelity is the whole argument of the theme.
 *  2. One rig, one material. A Part's 96px thumbnail and its expanded viewer
 *     read from the same `rig` and `material` entries (see previewRig.ts), so
 *     the small picture and the big picture cannot drift apart.
 */

import { useSyncExternalStore } from "react";

export type PreviewThemeMode = "light" | "dark";

export type PreviewLight = Readonly<{
  /** "#rrggbb". */
  color: string;
  intensity: number;
}>;

export type PreviewTheme = Readonly<{
  mode: PreviewThemeMode;
  /** Backdrop for any media surface — --media-bg. */
  background: string;
  /** Mid-tone stand-in used when a mesh colour is too close to `background`. */
  backgroundContrast: string;
  /** Sunken chrome behind media panels — --surface-sunken. */
  surface: string;
  /** Print bed fill: --media-bg nudged toward --foreground so it separates. */
  bed: string;
  /** Bed grid lines — --border-strong (major) over --border (minor). */
  grid: Readonly<{ major: string; minor: string }>;
  /** Shared MeshStandardMaterial parameters for every previewed mesh. */
  material: Readonly<{ metalness: number; roughness: number }>;
  /** Shared three-point rig. See the hue-only rule above. */
  rig: Readonly<{ ambient: PreviewLight; key: PreviewLight; fill: PreviewLight }>;
  /** ShadowMaterial opacity for the studio contact shadow. */
  shadowOpacity: number;
  /** Measurement lines and ticks — --warning. */
  dimension: string;
  /** Bounding box and other structural outlines — --border-strong. */
  outline: string;
  /** Selection and focus — --primary. Deliberately absent from `ramp`. */
  accent: string;
  foreground: string;
  mutedForeground: string;
  /**
   * Categorical fills for Plate units with no filament colour of their own.
   * The first five entries are the five most separable status hues, so the
   * common case (five or fewer Plates) never repeats or near-repeats.
   */
  ramp: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Every custom property this module reads. Names are stable; values are not. */
type TokenName =
  | "--media-bg"
  | "--surface-sunken"
  | "--foreground"
  | "--muted-foreground"
  | "--primary"
  | "--border"
  | "--border-strong"
  | "--warning"
  | "--info"
  | "--success"
  | "--destructive";

/**
 * Only used where the stylesheet was never loaded (unit tests under jsdom,
 * server rendering). Deliberately generic greys and textbook status hues
 * rather than a copy of the palette, so they cannot silently become a second
 * source of truth when the real tokens change.
 */
const FALLBACK: Record<PreviewThemeMode, Record<TokenName, string>> = {
  light: {
    "--media-bg": "hsl(0 0% 90%)",
    "--surface-sunken": "hsl(0 0% 93%)",
    "--foreground": "hsl(0 0% 12%)",
    "--muted-foreground": "hsl(0 0% 38%)",
    "--primary": "hsl(200 80% 34%)",
    "--border": "hsl(0 0% 80%)",
    "--border-strong": "hsl(0 0% 45%)",
    "--warning": "hsl(30 85% 34%)",
    "--info": "hsl(212 70% 38%)",
    "--success": "hsl(148 60% 28%)",
    "--destructive": "hsl(4 70% 42%)",
  },
  dark: {
    "--media-bg": "hsl(0 0% 6%)",
    "--surface-sunken": "hsl(0 0% 8%)",
    "--foreground": "hsl(0 0% 95%)",
    "--muted-foreground": "hsl(0 0% 68%)",
    "--primary": "hsl(195 70% 60%)",
    "--border": "hsl(0 0% 28%)",
    "--border-strong": "hsl(0 0% 52%)",
    "--warning": "hsl(40 85% 62%)",
    "--info": "hsl(212 72% 68%)",
    "--success": "hsl(146 48% 58%)",
    "--destructive": "hsl(4 75% 72%)",
  },
};

/** Photometrics are fixed so a theme switch never re-exposes the model. */
const AMBIENT_INTENSITY = 0.58;
const KEY_INTENSITY = 0.85;
const FILL_INTENSITY = 0.35;

// ---------------------------------------------------------------------------
// Colour arithmetic (sRGB, small and dependency free)
// ---------------------------------------------------------------------------

type Rgb = Readonly<{ r: number; g: number; b: number }>;
type Hsl = Readonly<{ h: number; s: number; l: number }>;

const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(value: string): Rgb | null {
  const digits = value.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(digits)) return null;
  const full =
    digits.length === 3
      ? digits.split("").map((d) => d + d).join("")
      : digits.slice(0, 6);
  const int = Number.parseInt(full, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

function components(body: string): string[] {
  return body.trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
}

function channel(token: string): number | null {
  const raw = token.endsWith("%") ? Number(token.slice(0, -1)) * 2.55 : Number(token);
  return Number.isFinite(raw) ? clamp(raw, 0, 255) : null;
}

function percent(token: string): number | null {
  const raw = Number(token.endsWith("%") ? token.slice(0, -1) : token);
  return Number.isFinite(raw) ? clamp(raw, 0, 100) : null;
}

function degrees(token: string): number | null {
  const raw = Number(token.replace(/deg$/i, ""));
  return Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : null;
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
      : h < 120 ? [x, c, 0]
        : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c]
            : h < 300 ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h =
    max === red ? 60 * (((green - blue) / delta) % 6)
      : max === green ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);
  return { h: ((h % 360) + 360) % 360, s: s * 100, l: l * 100 };
}

/** Parse any colour syntax the stylesheet is likely to hand back. */
function parseCssColor(value: string): Rgb | null {
  const input = value.trim();
  if (!input) return null;
  if (input.startsWith("#")) return parseHex(input);
  const call = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(input);
  if (!call) return null;
  const parts = components(call[2]);
  if (parts.length < 3) return null;
  if (call[1].toLowerCase().startsWith("rgb")) {
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (r == null || g == null || b == null) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  }
  const h = degrees(parts[0]);
  const s = percent(parts[1]);
  const l = percent(parts[2]);
  if (h == null || s == null || l == null) return null;
  return hslToRgb({ h, s, l });
}

let probe: HTMLSpanElement | null = null;

/**
 * Let the browser resolve anything this module cannot parse itself
 * (color-mix, oklch, named colours) by round-tripping it through a computed
 * `color`. Returns null outside a DOM.
 */
function probeCssColor(value: string): Rgb | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null;
  const host = document.body ?? document.documentElement;
  if (!host) return null;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.display = "none";
    host.appendChild(probe);
  }
  probe.style.color = "";
  probe.style.color = value;
  if (!probe.style.color) return null;
  return parseCssColor(getComputedStyle(probe).color ?? "");
}

function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  };
}

function withLightness(color: Rgb, lightness: number): Rgb {
  return hslToRgb({ ...rgbToHsl(color), l: clamp(lightness, 0, 100) });
}

/** Borrow a token's hue, discard its lightness, cap its saturation. */
function tint(color: Rgb, lightness: number, maxSaturation: number): Rgb {
  const { h, s } = rgbToHsl(color);
  return hslToRgb({ h, s: Math.min(s, maxSaturation), l: lightness });
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (value: number) => {
    const channelValue = value / 255;
    return channelValue <= 0.04045
      ? channelValue / 12.92
      : ((channelValue + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio (1..21) between two CSS colours. */
export function contrastRatio(a: string, b: string): number {
  const first = parseCssColor(a) ?? probeCssColor(a) ?? BLACK;
  const second = parseCssColor(b) ?? probeCssColor(b) ?? BLACK;
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Pick the themed ink that reads on an arbitrary fill — a phase colour from a
 * manifest, a filament hex, a ramp entry. The candidates are the theme's own
 * near-black and near-white, so the answer stays inside the palette.
 */
export function readableForeground(background: string, theme: PreviewTheme): string {
  const candidates = [theme.foreground, theme.surface];
  let best = candidates[0];
  let bestRatio = 0;
  for (const candidate of candidates) {
    const ratio = contrastRatio(background, candidate);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/**
 * Flatten a translucent fill onto its backdrop. The Plate bed paints unit
 * gradients at partial opacity, so the ink has to be judged against what is
 * actually on screen rather than against the nominal colour.
 */
export function blendColor(color: string, backdrop: string, alpha: number): string {
  const front = parseCssColor(color) ?? probeCssColor(color) ?? BLACK;
  const back = parseCssColor(backdrop) ?? probeCssColor(backdrop) ?? BLACK;
  return toHex(mix(back, front, alpha));
}

/** Categorical fill for the nth Plate unit without a filament colour. */
export function rampColor(theme: PreviewTheme, index: number): string {
  const ramp = theme.ramp;
  return ramp[((index % ramp.length) + ramp.length) % ramp.length];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function buildRamp(mode: PreviewThemeMode, seeds: readonly Rgb[]): readonly string[] {
  // Seat every hue in a lightness band that separates from --media-bg, then
  // walk two more bands so more than five Plates still get distinct fills.
  const band = mode === "dark" ? { min: 52, max: 74 } : { min: 28, max: 50 };
  const cycles = mode === "dark" ? [0, -14, 13] : [0, 14, -11];
  const ramp: string[] = [];
  for (const shift of cycles) {
    for (const seed of seeds) {
      const { h, s, l } = rgbToHsl(seed);
      const seated = clamp(l, band.min, band.max) + shift;
      ramp.push(toHex(hslToRgb({ h, s, l: clamp(seated, band.min - 14, band.max + 14) })));
    }
  }
  return ramp;
}

/** Read the tokens off <html> and derive every preview colour from them. */
export function resolvePreviewTheme(): PreviewTheme {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const mode: PreviewThemeMode = root?.classList.contains("dark") ? "dark" : "light";
  const declaration =
    root && typeof getComputedStyle === "function" ? getComputedStyle(root) : null;

  const token = (name: TokenName): Rgb => {
    const declared = declaration?.getPropertyValue(name).trim() ?? "";
    const fallback = FALLBACK[mode][name];
    const value = declared || fallback;
    return parseCssColor(value) ?? probeCssColor(value) ?? parseCssColor(fallback) ?? BLACK;
  };

  const media = token("--media-bg");
  const foreground = token("--foreground");

  return {
    mode,
    background: toHex(media),
    backgroundContrast: toHex(withLightness(media, 46)),
    surface: toHex(token("--surface-sunken")),
    bed: toHex(mix(media, foreground, mode === "dark" ? 0.12 : 0.09)),
    grid: { major: toHex(token("--border-strong")), minor: toHex(token("--border")) },
    material: { metalness: 0.15, roughness: 0.65 },
    rig: {
      ambient: { color: toHex(tint(media, 98, 5)), intensity: AMBIENT_INTENSITY },
      key: { color: toHex(tint(token("--warning"), 97, 8)), intensity: KEY_INTENSITY },
      fill: { color: toHex(tint(token("--info"), 95, 8)), intensity: FILL_INTENSITY },
    },
    shadowOpacity: mode === "dark" ? 0.4 : 0.24,
    dimension: toHex(token("--warning")),
    outline: toHex(token("--border-strong")),
    accent: toHex(token("--primary")),
    foreground: toHex(foreground),
    mutedForeground: toHex(token("--muted-foreground")),
    ramp: buildRamp(mode, [
      token("--info"),
      token("--warning"),
      token("--success"),
      token("--destructive"),
      token("--muted-foreground"),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Store — one snapshot, invalidated when <html> changes theme
// ---------------------------------------------------------------------------

let snapshot: PreviewTheme | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function watchDocumentTheme(): void {
  if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return;
  }
  observer = new MutationObserver(() => refreshPreviewTheme());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
}

/** The current theme. Cached, so it is safe as a useSyncExternalStore snapshot. */
export function previewTheme(): PreviewTheme {
  if (!snapshot) {
    snapshot = resolvePreviewTheme();
    watchDocumentTheme();
  }
  return snapshot;
}

/** Re-read the tokens; notify subscribers only when something actually moved. */
export function refreshPreviewTheme(): PreviewTheme {
  const next = resolvePreviewTheme();
  if (snapshot && JSON.stringify(snapshot) === JSON.stringify(next)) return snapshot;
  snapshot = next;
  for (const listener of listeners) listener();
  return next;
}

export function subscribePreviewTheme(listener: () => void): () => void {
  listeners.add(listener);
  watchDocumentTheme();
  return () => {
    listeners.delete(listener);
  };
}

/** Theme-aware preview colours for React consumers. */
export function usePreviewTheme(): PreviewTheme {
  return useSyncExternalStore(subscribePreviewTheme, previewTheme, previewTheme);
}
